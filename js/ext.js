/**
 * Mostafa Style Caption - Local Offline Speech-to-Text
 * 
 * Uses whisper.cpp (no Python, no API key, no cloud).
 * Bundles ffmpeg for audio conversion.
 * Downloads GGML models on first use.
 */

/* global CSInterface, SystemPath */

var fs = null;
var path = null;
var https = null;
var http = null;
var os = null;
var childProcess = null;
var nodeEnabled = false;

try {
    fs = require('fs');
    path = require('path');
    https = require('https');
    http = require('http');
    os = require('os');
    childProcess = require('child_process');
    nodeEnabled = true;
} catch (e) {
    console.error('[MSC] Node.js modules failed:', e.message);
}

var csInterface = null;
var isProcessing = false;
var cancelRequested = false;
var tempFiles = [];

// Paths resolved at load time
var EXT_DIR = '';     // Extension root directory
var BIN_DIR = '';     // bin/ folder inside extension
var MODELS_DIR = '';  // models/ folder inside extension
var WHISPER_EXE = '';
var FFMPEG_EXE = '';

// Model download URLs (HuggingFace, whisper.cpp GGML format)
var MODEL_URLS = {
    'tiny':     'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    'base':     'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    'small':    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    'medium':   'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    'large-v3': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
};

var MODEL_FILENAMES = {
    'tiny':     'ggml-tiny.bin',
    'base':     'ggml-base.bin',
    'small':    'ggml-small.bin',
    'medium':   'ggml-medium.bin',
    'large-v3': 'ggml-large-v3.bin'
};

function log(m) { console.log('[MSC] ' + m); }
function logError(m) { console.error('[MSC ERROR] ' + m); }

// ─── Initialization ────────────────────────────────────────────

function onLoaded() {
    csInterface = new CSInterface();
    
    EXT_DIR = csInterface.getSystemPath(SystemPath.EXTENSION);
    
    // IMPORTANT: The CEP extensions folder under Program Files is READ-ONLY.
    // We MUST store downloaded binaries and models in a user-writable location.
    // Use AppData/Local/MostafaStyleCaption — always writable, persists across sessions.
    var userDataDir;
    if (process.platform === 'win32') {
        userDataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MostafaStyleCaption');
    } else {
        userDataDir = path.join(os.homedir(), '.MostafaStyleCaption');
    }
    
    BIN_DIR = path.join(userDataDir, 'bin');
    MODELS_DIR = path.join(userDataDir, 'models');
    WHISPER_EXE = path.join(BIN_DIR, 'whisper-cli.exe');
    FFMPEG_EXE = path.join(BIN_DIR, 'ffmpeg.exe');
    
    log('Extension dir: ' + EXT_DIR);
    log('Data dir: ' + userDataDir);
    log('Bin dir: ' + BIN_DIR);
    log('Models dir: ' + MODELS_DIR);
    log('Node.js: ' + (nodeEnabled ? 'OK' : 'MISSING'));
    
    // Create writable directories
    try {
        mkdirp(userDataDir);
        mkdirp(BIN_DIR);
        mkdirp(MODELS_DIR);
        log('Directories created/verified');
    } catch (e) {
        logError('Cannot create data directories: ' + e.message);
    }
    
    // Also check if binaries were bundled inside the extension folder (pre-packaged)
    var bundledWhisper = path.join(EXT_DIR, 'bin', 'whisper-cli.exe');
    var bundledFFmpeg = path.join(EXT_DIR, 'bin', 'ffmpeg.exe');
    
    try {
        if (!fs.existsSync(WHISPER_EXE) && fs.existsSync(bundledWhisper)) {
            fs.copyFileSync(bundledWhisper, WHISPER_EXE);
            log('Copied bundled whisper-cli.exe to data dir');
            // Copy DLLs too
            var bundledBinDir = path.join(EXT_DIR, 'bin');
            fs.readdirSync(bundledBinDir).forEach(function(f) {
                if (f.endsWith('.dll')) {
                    try { fs.copyFileSync(path.join(bundledBinDir, f), path.join(BIN_DIR, f)); } catch (e) {}
                }
            });
        }
        if (!fs.existsSync(FFMPEG_EXE) && fs.existsSync(bundledFFmpeg)) {
            fs.copyFileSync(bundledFFmpeg, FFMPEG_EXE);
            log('Copied bundled ffmpeg.exe to data dir');
        }
    } catch (e) {
        log('Bundled binary check: ' + e.message);
    }
    
    updateThemeWithAppSkinInfo(csInterface.hostEnvironment.appSkinInfo);
    csInterface.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, onAppThemeColorChanged);
    
    updateActiveSequence();
    csInterface.evalScript('$._MSC_.keepPanelLoaded()');
    checkAllStatus();
}

/** Create directory and all parents (works on older Node) */
function mkdirp(dir) {
    if (fs.existsSync(dir)) return;
    var parent = path.dirname(dir);
    if (parent !== dir) mkdirp(parent);
    fs.mkdirSync(dir);
}

function updateActiveSequence() {
    csInterface.evalScript('$._MSC_.getActiveSequenceName()', function(r) {
        var el = document.getElementById('active_seq');
        if (el) el.innerHTML = 'السيكونس النشط: ' + r;
    });
}

function openURL(url) {
    csInterface.openURLInDefaultBrowser(url);
    return false;
}

function checkAllStatus() {
    var model = document.getElementById('model_size').value;
    var modelFile = path.join(MODELS_DIR, MODEL_FILENAMES[model]);
    
    var whisperOK = fs.existsSync(WHISPER_EXE);
    var ffmpegOK = fs.existsSync(FFMPEG_EXE);
    var modelOK = fs.existsSync(modelFile);
    
    setDiag('diag_ffmpeg',  ffmpegOK  ? 'ok' : 'missing',  'FFmpeg: '  + (ffmpegOK  ? 'مُثبّت ✓' : 'غير موجود — سيتم التحميل تلقائياً'));
    setDiag('diag_whisper', whisperOK ? 'ok' : 'missing', 'Whisper: ' + (whisperOK ? 'مُثبّت ✓' : 'غير موجود — سيتم التحميل تلقائياً'));
    setDiag('diag_model', modelOK ? 'ok' : 'missing', 'النموذج (' + model + '): ' + (modelOK ? 'جاهز ✓' : 'سيتم التحميل عند أول استخدام'));
}

function setDiag(id, state, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'diag-row ' + state;
    // Rebuild content: dot + text
    while (el.firstChild) el.removeChild(el.firstChild);
    var dot = document.createElement('span');
    dot.className = 'diag-dot';
    el.appendChild(dot);
    el.appendChild(document.createTextNode(' ' + text));
}

// Alias for backward compat
function checkModelStatus() { checkAllStatus(); }

// ─── Main Pipeline ─────────────────────────────────────────────

function generateCaptions() {
    if (isProcessing) return;
    if (!nodeEnabled) {
        showStatus('Node.js غير مفعّل.\nأعد تشغيل بريمير.', 'error');
        return;
    }
    
    isProcessing = true;
    cancelRequested = false;
    tempFiles = [];
    
    setButtonState(false);
    showProgress(true);
    hideStatus();
    hideCaptionPreview();
    hideImportButton();
    
    var modelSize = document.getElementById('model_size').value;
    var language = document.getElementById('language').value;
    
    updateProgress(2, 'جاري التحضير...');
    
    // Step 1: Ensure binaries exist
    ensureBinaries(function(binOK) {
        if (!binOK) {
            finishWithError('فشل التحميل التلقائي.\n\nتأكد من اتصال الإنترنت وحاول مرة أخرى.\n\nأو حمّل يدوياً:\n• whisper-cli.exe من github.com/ggml-org/whisper.cpp/releases\n• ffmpeg.exe من gyan.dev/ffmpeg/builds\n\nوضعها في:\n' + BIN_DIR);
            return;
        }
        
        if (cancelRequested) {
            finishWithError('تم الإلغاء.');
            return;
        }
        
        // Step 2: Ensure model exists
        var modelFile = path.join(MODELS_DIR, MODEL_FILENAMES[modelSize]);
        if (fs.existsSync(modelFile)) {
            log('Model already downloaded: ' + modelFile);
            startTranscription(modelFile, language);
        } else {
            downloadModel(modelSize, function(dlOK) {
                if (!dlOK) {
                    finishWithError('فشل تحميل النموذج.\nتأكد من اتصال الإنترنت.');
                    return;
                }
                if (cancelRequested) {
                    finishWithError('تم الإلغاء.');
                    return;
                }
                startTranscription(modelFile, language);
            });
        }
    });
}

function ensureBinaries(callback) {
    var whisperOK = fs.existsSync(WHISPER_EXE);
    var ffmpegOK = fs.existsSync(FFMPEG_EXE);
    
    log('whisper-cli.exe: ' + (whisperOK ? 'found' : 'MISSING'));
    log('ffmpeg.exe: ' + (ffmpegOK ? 'found' : 'MISSING'));
    
    if (whisperOK && ffmpegOK) {
        callback(true);
        return;
    }
    
    // Auto-download missing binaries
    var steps = [];
    if (!whisperOK) steps.push('whisper');
    if (!ffmpegOK) steps.push('ffmpeg');
    
    var currentStep = 0;
    
    function nextStep() {
        if (currentStep >= steps.length) {
            // Verify after download
            var wOK = fs.existsSync(WHISPER_EXE);
            var fOK = fs.existsSync(FFMPEG_EXE);
            checkAllStatus();
            if (wOK && fOK) {
                callback(true);
            } else {
                callback(false);
            }
            return;
        }
        
        var step = steps[currentStep];
        currentStep++;
        
        if (step === 'whisper') {
            downloadWhisperBinary(function(ok) {
                if (!ok) { callback(false); return; }
                nextStep();
            });
        } else if (step === 'ffmpeg') {
            downloadFFmpegBinary(function(ok) {
                if (!ok) { callback(false); return; }
                nextStep();
            });
        }
    }
    
    nextStep();
}

function downloadWhisperBinary(callback) {
    var zipUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip';
    var zipPath = path.join(os.tmpdir(), 'msc_whisper_' + Date.now() + '.zip');
    var extractDir = path.join(os.tmpdir(), 'msc_whisper_extract_' + Date.now());
    
    log('Downloading whisper.cpp binary...');
    setDiag('diag_whisper', 'downloading', 'Whisper: جاري التحميل...');
    updateProgress(3, 'جاري تحميل whisper-cli.exe...');
    
    downloadFile(zipUrl, zipPath, function(pct) {
        updateProgress(3 + Math.round(pct * 0.04), 'جاري تحميل Whisper... ' + pct + '%');
        setDiag('diag_whisper', 'downloading', 'Whisper: جاري التحميل ' + pct + '%');
    }, function(err) {
        if (err) {
            logError('Whisper download failed: ' + err);
            setDiag('diag_whisper', 'missing', 'Whisper: فشل التحميل');
            try { fs.unlinkSync(zipPath); } catch (e) {}
            callback(false);
            return;
        }
        
        log('Whisper zip downloaded, extracting...');
        updateProgress(8, 'جاري فك الضغط whisper-cli.exe...');
        setDiag('diag_whisper', 'downloading', 'Whisper: جاري فك الضغط...');
        
        // Extract using PowerShell (available on all modern Windows)
        var psCmd = 'powershell -NoProfile -Command "Expand-Archive -Path \'' + zipPath.replace(/'/g, "''") + '\' -DestinationPath \'' + extractDir.replace(/'/g, "''") + '\' -Force"';
        
        childProcess.exec(psCmd, { timeout: 60000 }, function(error, stdout, stderr) {
            // Cleanup zip
            try { fs.unlinkSync(zipPath); } catch (e) {}
            
            if (error) {
                logError('Extraction failed: ' + error.message);
                setDiag('diag_whisper', 'missing', 'Whisper: فشل فك الضغط');
                callback(false);
                return;
            }
            
            // Find whisper-cli.exe recursively
            var found = findFileRecursive(extractDir, 'whisper-cli.exe');
            if (found) {
                try {
                    fs.copyFileSync(found, WHISPER_EXE);
                    log('Installed: ' + WHISPER_EXE);
                    
                    // Also copy any DLLs next to whisper-cli.exe
                    var srcDir = path.dirname(found);
                    var dlls = fs.readdirSync(srcDir).filter(function(f) { return f.endsWith('.dll'); });
                    dlls.forEach(function(dll) {
                        try {
                            fs.copyFileSync(path.join(srcDir, dll), path.join(BIN_DIR, dll));
                            log('Copied DLL: ' + dll);
                        } catch (e) {}
                    });
                    
                    setDiag('diag_whisper', 'ok', 'Whisper: تم التثبيت ✓');
                } catch (e) {
                    logError('Copy failed: ' + e.message);
                    setDiag('diag_whisper', 'missing', 'Whisper: فشل النسخ');
                    cleanDir(extractDir);
                    callback(false);
                    return;
                }
            } else {
                logError('whisper-cli.exe not found in archive');
                setDiag('diag_whisper', 'missing', 'Whisper: غير موجود في الأرشيف');
                cleanDir(extractDir);
                callback(false);
                return;
            }
            
            cleanDir(extractDir);
            callback(true);
        });
    });
}

function downloadFFmpegBinary(callback) {
    var zipUrl = 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip';
    var zipPath = path.join(os.tmpdir(), 'msc_ffmpeg_' + Date.now() + '.zip');
    var extractDir = path.join(os.tmpdir(), 'msc_ffmpeg_extract_' + Date.now());
    
    log('Downloading FFmpeg binary...');
    setDiag('diag_ffmpeg', 'downloading', 'FFmpeg: جاري التحميل...');
    updateProgress(9, 'جاري تحميل ffmpeg.exe...');
    
    downloadFile(zipUrl, zipPath, function(pct) {
        updateProgress(9 + Math.round(pct * 0.06), 'جاري تحميل FFmpeg... ' + pct + '%');
        setDiag('diag_ffmpeg', 'downloading', 'FFmpeg: جاري التحميل ' + pct + '%');
    }, function(err) {
        if (err) {
            logError('FFmpeg download failed: ' + err);
            setDiag('diag_ffmpeg', 'missing', 'FFmpeg: فشل التحميل');
            try { fs.unlinkSync(zipPath); } catch (e) {}
            callback(false);
            return;
        }
        
        log('FFmpeg zip downloaded, extracting...');
        updateProgress(16, 'جاري فك الضغط ffmpeg.exe...');
        setDiag('diag_ffmpeg', 'downloading', 'FFmpeg: جاري فك الضغط...');
        
        var psCmd = 'powershell -NoProfile -Command "Expand-Archive -Path \'' + zipPath.replace(/'/g, "''") + '\' -DestinationPath \'' + extractDir.replace(/'/g, "''") + '\' -Force"';
        
        childProcess.exec(psCmd, { timeout: 120000 }, function(error) {
            try { fs.unlinkSync(zipPath); } catch (e) {}
            
            if (error) {
                logError('FFmpeg extraction failed: ' + error.message);
                setDiag('diag_ffmpeg', 'missing', 'FFmpeg: فشل فك الضغط');
                callback(false);
                return;
            }
            
            var found = findFileRecursive(extractDir, 'ffmpeg.exe');
            if (found) {
                try {
                    fs.copyFileSync(found, FFMPEG_EXE);
                    log('Installed: ' + FFMPEG_EXE);
                    setDiag('diag_ffmpeg', 'ok', 'FFmpeg: تم التثبيت ✓');
                } catch (e) {
                    logError('Copy failed: ' + e.message);
                    setDiag('diag_ffmpeg', 'missing', 'FFmpeg: فشل النسخ');
                    cleanDir(extractDir);
                    callback(false);
                    return;
                }
            } else {
                logError('ffmpeg.exe not found in archive');
                setDiag('diag_ffmpeg', 'missing', 'FFmpeg: غير موجود في الأرشيف');
                cleanDir(extractDir);
                callback(false);
                return;
            }
            
            cleanDir(extractDir);
            callback(true);
        });
    });
}

/** Recursively find a file by name */
function findFileRecursive(dir, filename) {
    try {
        var entries = fs.readdirSync(dir);
        for (var i = 0; i < entries.length; i++) {
            var entryPath = path.join(dir, entries[i]);
            var stat = fs.statSync(entryPath);
            if (stat.isDirectory()) {
                var found = findFileRecursive(entryPath, filename);
                if (found) return found;
            } else if (entries[i].toLowerCase() === filename.toLowerCase()) {
                return entryPath;
            }
        }
    } catch (e) {}
    return null;
}

/** Remove directory recursively */
function cleanDir(dir) {
    try {
        var entries = fs.readdirSync(dir);
        entries.forEach(function(entry) {
            var entryPath = path.join(dir, entry);
            if (fs.statSync(entryPath).isDirectory()) {
                cleanDir(entryPath);
            } else {
                fs.unlinkSync(entryPath);
            }
        });
        fs.rmdirSync(dir);
    } catch (e) {}
}

function cleanupTempFiles() {
    tempFiles.forEach(function(f) {
        try { fs.unlinkSync(f); } catch (e) {}
    });
    tempFiles = [];
}

// ─── Model Download ────────────────────────────────────────────

function downloadModel(modelSize, callback) {
    var url = MODEL_URLS[modelSize];
    var filename = MODEL_FILENAMES[modelSize];
    var destPath = path.join(MODELS_DIR, filename);
    
    log('Downloading model: ' + modelSize + ' from ' + url);
    updateProgress(18, 'جاري تحميل نموذج ' + modelSize + '...');
    setDiag('diag_model', 'downloading', 'النموذج: جاري التحميل...');
    
    downloadFile(url, destPath, function(pct) {
        updateProgress(18 + Math.round(pct * 0.04), 'جاري تحميل النموذج... ' + pct + '%');
        setDiag('diag_model', 'downloading', 'النموذج: جاري التحميل ' + pct + '%');
    }, function(err) {
        if (err) {
            logError('Model download failed: ' + err);
            setDiag('diag_model', 'missing', 'النموذج: فشل التحميل');
            callback(false);
            return;
        }
        log('Model downloaded: ' + destPath);
        setDiag('diag_model', 'ok', 'النموذج (' + modelSize + '): جاهز ✓');
        callback(true);
    });
}

/** Download file with progress callback */
function downloadFile(url, destPath, onProgress, onDone) {
    var protocol = url.startsWith('https') ? https : http;
    var done = false;
    
    function finish(err) {
        if (done) return;
        done = true;
        onDone(err);
    }
    
    var req = protocol.get(url, function(res) {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            var redirectUrl = res.headers.location;
            log('Redirect: ' + redirectUrl);
            downloadFile(redirectUrl, destPath, onProgress, onDone);
            return;
        }
        
        if (res.statusCode !== 200) {
            finish('HTTP ' + res.statusCode);
            return;
        }
        
        var totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        var receivedBytes = 0;
        var fileStream = fs.createWriteStream(destPath);
        
        res.on('data', function(chunk) {
            receivedBytes += chunk.length;
            fileStream.write(chunk);
            if (totalBytes > 0) {
                var pct = Math.round((receivedBytes / totalBytes) * 100);
                onProgress(pct);
            }
        });
        
        res.on('end', function() {
            fileStream.end(function() {
                finish(null);
            });
        });
        
        res.on('error', function(e) {
            finish(e.message);
        });
    });
    
    req.on('error', function(e) {
        finish(e.message);
    });
    
    req.setTimeout(600000, function() {
        req.destroy();
        finish('انتهت مهلة التحميل');
    });
}

// ─── Transcription ─────────────────────────────────────────────

function startTranscription(modelFile, language) {
    updateProgress(22, 'جاري استخراج الوسائط...');
    
    csInterface.evalScript('$._MSC_.getSequenceMediaPath()', function(mediaResult) {
        var mediaData;
        try {
            mediaData = JSON.parse(mediaResult);
        } catch (e) {
            finishWithError('فشل في الحصول على معلومات الوسائط.');
            return;
        }
        
        if (!mediaData.success) {
            finishWithError(mediaData.message || 'لا توجد وسائط في السيكونس.');
            return;
        }
        
        var sourcePath = mediaData.mediaPath;
        log('Source media: ' + sourcePath);
        
        if (cancelRequested) {
            finishWithError('تم الإلغاء.');
            return;
        }
        
        // Step 3: Convert audio with ffmpeg
        updateProgress(25, 'جاري تحويل الصوت (16 kHz أحادي)...');
        
        var wavPath = path.join(os.tmpdir(), 'msc_audio_' + Date.now() + '.wav');
        tempFiles.push(wavPath);
        
        convertAudio(sourcePath, wavPath, function(convErr) {
            if (convErr) {
                finishWithError('فشل تحويل الصوت:\n' + convErr);
                return;
            }
            
            if (!fs.existsSync(wavPath)) {
                finishWithError('ملف الصوت المحوّل غير موجود.');
                return;
            }
            
            var wavSize = (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1);
            log('WAV file ready: ' + wavSize + ' MB');
            
            if (cancelRequested) {
                finishWithError('تم الإلغاء.');
                return;
            }
            
            // Step 4: Run whisper.cpp
            updateProgress(35, 'جاري التفريغ بـ Whisper (بدون إنترنت)...');
            
            runWhisper(wavPath, modelFile, language, function(whisperResult) {
                if (!whisperResult.success) {
                    finishWithError('فشل التفريغ:\n' + whisperResult.message);
                    return;
                }
                
                if (cancelRequested) {
                    finishWithError('تم الإلغاء.');
                    return;
                }
                
                handleTranscriptionResult(whisperResult);
            });
        });
    });
}

// ─── FFmpeg Audio Conversion ───────────────────────────────────

function convertAudio(inputPath, outputPath, callback) {
    log('Converting audio: ' + inputPath + ' → ' + outputPath);
    
    var done = false;
    function finish(err) {
        if (done) return;
        done = true;
        callback(err);
    }
    
    var args = [
        '-y',
        '-i', inputPath,
        '-vn',           // no video
        '-ac', '1',      // mono
        '-ar', '16000',  // 16 kHz
        '-sample_fmt', 's16', // 16-bit PCM
        '-f', 'wav',
        outputPath
    ];
    
    var child = childProcess.spawn(FFMPEG_EXE, args, { windowsHide: true });
    var stderr = '';
    
    child.stderr.on('data', function(d) { stderr += d.toString(); });
    
    child.on('error', function(e) {
        finish('خطأ FFmpeg: ' + e.message);
    });
    
    child.on('close', function(code) {
        if (code === 0) {
            log('Audio conversion complete');
            finish(null);
        } else {
            logError('FFmpeg exit code ' + code);
            finish('FFmpeg رمز الخروج ' + code + '\n' + stderr.substring(0, 500));
        }
    });
    
    // 5 minute timeout for very long videos
    setTimeout(function() {
        if (!done && !child.killed) {
            child.kill();
            finish('انتهت مهلة FFmpeg');
        }
    }, 300000);
}

// ─── Whisper.cpp Execution ─────────────────────────────────────

function runWhisper(wavPath, modelPath, language, callback) {
    var done = false;
    function finish(r) {
        if (done) return;
        done = true;
        callback(r);
    }
    
    var outputBase = wavPath.replace(/\.wav$/, '');
    var srtPath = outputBase + '.srt';
    var jsonPath = outputBase + '.json';
    
    tempFiles.push(srtPath);
    tempFiles.push(jsonPath);
    
    // Determine thread count (use most cores but leave 2 for OS/Premiere)
    var cpuCount = os.cpus().length;
    var threads = Math.max(2, cpuCount - 2);
    
    var args = [
        '-m', modelPath,
        '-f', wavPath,
        '-ojf',         // output-json-full: includes per-token timestamps + probability
        '-osrt',        // also output SRT as backup
        '-of', outputBase, // output file basename
        '-t', String(threads), // CPU threads
        '-bs', '5',     // beam size 5 for accuracy
        '-bo', '5',     // best-of 5 candidates
        '-mc', '64',    // max context tokens (use previous text for coherence)
        '-ml', '50',    // max segment length 50 chars (good for captions)
        '-sow',         // split on word boundaries
        '-wt', '0.01',  // word timestamp probability threshold
        '-et', '2.4',   // entropy threshold for decoder fallback
        '-lpt', '-1.0', // logprob threshold
        '-nth', '0.6',  // no-speech threshold (skip silence)
        '-pp',          // print progress
        '-fa',          // flash attention (faster if supported)
        '--no-prints'
    ];
    
    // Language handling
    if (language === 'auto' || !language) {
        args.push('-l', 'auto'); // auto-detect (handles Arabic/English/mixed)
    } else {
        args.push('-l', language);
    }
    
    // Initial prompt to improve Arabic recognition and punctuation
    var prompt = '';
    if (language === 'ar') {
        prompt = 'هذا تسجيل صوتي باللغة العربية. يرجى النسخ بدقة مع علامات الترقيم.';
    } else if (language === 'en') {
        prompt = 'Transcribe accurately with proper punctuation, commas, and periods.';
    } else {
        // Auto mode - bilingual prompt helps with mixed content
        prompt = 'Transcribe with punctuation. النسخ مع علامات الترقيم.';
    }
    args.push('--prompt', prompt);
    
    log('Running whisper.cpp with quality settings:');
    log('  Threads: ' + threads + ' (of ' + cpuCount + ' CPUs)');
    log('  Beam size: 5');
    log('  Best-of: 5');
    log('  Language: ' + (language || 'auto'));
    log('  Flash attention: enabled');
    log('  Full JSON output: enabled (token probabilities)');
    log('Command: ' + WHISPER_EXE + ' ' + args.join(' '));
    
    var startTime = Date.now();
    var child = childProcess.spawn(WHISPER_EXE, args, { windowsHide: true });
    
    var stdout = '';
    var stderr = '';
    
    child.stdout.on('data', function(data) {
        stdout += data.toString();
        parseProgressFromOutput(data.toString(), startTime);
    });
    
    child.stderr.on('data', function(data) {
        stderr += data.toString();
        parseProgressFromOutput(data.toString(), startTime);
    });
    
    child.on('error', function(err) {
        logError('Whisper spawn error: ' + err.message);
        finish({
            success: false,
            message: 'لم يتمكن من تشغيل whisper-cli.exe:\n' + err.message
        });
    });
    
    child.on('close', function(code) {
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log('Whisper finished in ' + elapsed + 's, exit code ' + code);
        
        if (code !== 0) {
            logError('Whisper stderr: ' + stderr.substring(0, 1000));
            
            // If flash-attn fails, retry without it
            if (stderr.indexOf('flash') !== -1 || stderr.indexOf('FLASH') !== -1) {
                log('Flash attention failed, retrying without it...');
                var idx = args.indexOf('-fa');
                if (idx !== -1) args.splice(idx, 1);
                
                var retry = childProcess.spawn(WHISPER_EXE, args, { windowsHide: true });
                var retryOut = '', retryErr = '';
                
                retry.stdout.on('data', function(d) { retryOut += d; parseProgressFromOutput(d.toString(), startTime); });
                retry.stderr.on('data', function(d) { retryErr += d; parseProgressFromOutput(d.toString(), startTime); });
                
                retry.on('close', function(c2) {
                    if (c2 !== 0) {
                        finish({
                            success: false,
                            message: 'فشل Whisper (رمز ' + c2 + ')\n' + retryErr.substring(0, 500)
                        });
                    } else {
                        processWhisperOutput(jsonPath, srtPath, language, finish);
                    }
                });
                
                retry.on('error', function(e) {
                    finish({ success: false, message: e.message });
                });
                
                return;
            }
            
            finish({
                success: false,
                message: 'خرج Whisper برمز ' + code + '\n' + stderr.substring(0, 500)
            });
            return;
        }
        
        processWhisperOutput(jsonPath, srtPath, language, finish);
    });
    
    // 60 minute timeout for large-v3 on long files
    setTimeout(function() {
        if (!done && !child.killed) {
            child.kill();
            finish({
                success: false,
                message: 'انتهت مهلة التفريغ (60 دقيقة)'
            });
        }
    }, 3600000);
}

function parseProgressFromOutput(text, startTime) {
    var match = text.match(/progress\s*=\s*(\d+)%/i);
    if (match) {
        var wp = parseInt(match[1], 10);
        var overallP = 35 + Math.round(wp * 0.45); // 35% to 80%
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        updateProgress(overallP, 'جاري التفريغ... ' + wp + '% (' + elapsed + ' ثانية)');
    }
}

/**
 * Process whisper.cpp output with quality post-processing
 */
function processWhisperOutput(jsonPath, srtPath, language, finish) {
    var segments = [];
    var totalWords = 0;
    var lowConfCount = 0;
    
    // Try JSON first (has confidence scores)
    if (fs.existsSync(jsonPath)) {
        try {
            var jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (jsonData.transcription && Array.isArray(jsonData.transcription)) {
                jsonData.transcription.forEach(function(seg) {
                    var segStart = parseTimestamp(seg.timestamps.from);
                    var segEnd = parseTimestamp(seg.timestamps.to);
                    var segText = (seg.text || '').trim();
                    
                    if (!segText) return;
                    
                    var words = [];
                    var tokenConfidences = [];
                    
                    if (seg.tokens && Array.isArray(seg.tokens)) {
                        seg.tokens.forEach(function(tok) {
                            if (!tok.timestamps) return;
                            if (tok.id >= 50000) return; // special tokens
                            if (!tok.text || !tok.text.trim()) return;
                            
                            var wordText = tok.text.trim();
                            var conf = (typeof tok.p === 'number') ? tok.p : 1.0;
                            
                            tokenConfidences.push(conf);
                            words.push({
                                text: wordText,
                                start: parseTimestamp(tok.timestamps.from),
                                end: parseTimestamp(tok.timestamps.to),
                                confidence: conf,
                                lowConfidence: conf < 0.5
                            });
                            
                            totalWords++;
                            if (conf < 0.5) lowConfCount++;
                        });
                    }
                    
                    var segConfidence = 1.0;
                    if (tokenConfidences.length > 0) {
                        segConfidence = tokenConfidences.reduce(function(a, b) { return a + b; }, 0) / tokenConfidences.length;
                    }
                    
                    segments.push({
                        start: segStart,
                        end: segEnd,
                        text: segText,
                        words: words,
                        confidence: segConfidence,
                        lowConfidence: segConfidence < 0.6
                    });
                });
            }
        } catch (e) {
            log('JSON parse error: ' + e.message + ', falling back to SRT');
        }
    }
    
    // Fallback to SRT if JSON failed
    if (segments.length === 0 && fs.existsSync(srtPath)) {
        try {
            var srtContent = fs.readFileSync(srtPath, 'utf8');
            segments = parseSRT(srtContent);
            segments.forEach(function(s) {
                totalWords += s.text.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
            });
        } catch (e) {
            log('SRT parse error: ' + e.message);
        }
    }
    
    if (segments.length === 0) {
        finish({
            success: false,
            message: 'لم يتم العثور على كلام في الملف الصوتي.\nتأكد من وجود صوت واضح في السيكونس.'
        });
        return;
    }
    
    // Calculate total duration
    var totalDuration = segments.length > 0 ? segments[segments.length - 1].end : 0;
    
    finish({
        success: true,
        segments: segments,
        srtPath: srtPath,
        duration: totalDuration,
        language: language || 'auto',
        totalWords: totalWords,
        lowConfidenceWords: lowConfCount
    });
}

function parseTimestamp(ts) {
    // Parse "HH:MM:SS.mmm" or "HH:MM:SS,mmm" to seconds
    if (typeof ts === 'number') return ts;
    var parts = ts.replace(',', '.').split(':');
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(ts) || 0;
}

function parseSRT(srtText) {
    var segments = [];
    var blocks = srtText.trim().split(/\n\s*\n/);
    
    for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].trim().split('\n');
        if (lines.length >= 3) {
            var timeLine = lines[1];
            var textLines = lines.slice(2).join(' ').trim();
            
            var timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
            if (timeMatch && textLines) {
                segments.push({
                    start: parseTimestamp(timeMatch[1]),
                    end: parseTimestamp(timeMatch[2]),
                    text: textLines
                });
            }
        }
    }
    
    return segments;
}

// ─── Handle Results ────────────────────────────────────────────

// Store last result for import button
var lastTranscriptionResult = null;

function handleTranscriptionResult(result) {
    if (!result.success) {
        cleanupTempFiles();
        finishWithError(result.message || 'فشل التفريغ');
        return;
    }
    
    // Store result for later import
    lastTranscriptionResult = result;
    
    log('Transcription complete: ' + result.segments.length + ' segments');
    updateProgress(100, 'تم بنجاح!');
    
    var msg = '✓ اكتمل التفريغ بنجاح (بدون إنترنت)\n\n';
    msg += 'عدد المقاطع: ' + result.segments.length + '\n';
    msg += 'المدة: ' + formatDuration(result.duration) + '\n';
    
    if (result.totalWords) {
        msg += 'عدد الكلمات: ' + result.totalWords + '\n';
        if (result.lowConfidenceWords > 0) {
            msg += 'كلمات غير مؤكدة: ' + result.lowConfidenceWords + ' (باللون البرتقالي)\n';
        } else {
            msg += 'الثقة: جميع الكلمات بدقة عالية ✓\n';
        }
    }
    
    showStatus(msg, 'success');
    showCaptionPreview(result.segments);
    showImportButton();
    openEditor(result.segments);
    
    setTimeout(cleanupTempFiles, 5000);
    finishProcessing();
}

// ─── Import Captions to Premiere ───────────────────────────────

function importCaptionsToPremiere() {
    if (!lastTranscriptionResult || !lastTranscriptionResult.segments) {
        showStatus('لا توجد ترجمات للاستيراد. قم بتوليد الترجمات أولاً.', 'error');
        return;
    }
    
    var result = lastTranscriptionResult;
    
    updateProgress(85, 'جاري استيراد الترجمات إلى بريمير...');
    showProgress(true);
    
    // Create SRT file for import
    var srtPath = result.srtPath;
    if (!srtPath || !fs.existsSync(srtPath)) {
        // Generate SRT from segments — with UTF-8 BOM for Arabic
        srtPath = path.join(os.tmpdir(), 'msc_captions_' + Date.now() + '.srt');
        var srtContent = '\uFEFF' + createSRT(result.segments);
        fs.writeFileSync(srtPath, srtContent, 'utf8');
        tempFiles.push(srtPath);
    }
    
    var escapedPath = srtPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    
    csInterface.evalScript("$._MSC_.importSRTAndCreateCaptions('" + escapedPath + "')", function(importResult) {
        var importData;
        try {
            importData = JSON.parse(importResult);
        } catch (e) {
            importData = { success: false, message: importResult };
        }
        
        updateProgress(92, 'جاري إنشاء العلامات على التايملاين...');
        
        // Create markers
        var markerSegs = result.segments.map(function(s) {
            return { start: s.start, end: s.end, text: s.text };
        });
        var segJSON = JSON.stringify(markerSegs).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        
        csInterface.evalScript("$._MSC_.createCaptionMarkers('" + segJSON + "')", function() {
            updateProgress(100, 'تم الاستيراد بنجاح!');
            
            var msg = '';
            if (importData.success) {
                msg = '✓ تم استيراد الترجمات بنجاح!\n\n';
                msg += '✓ تم استيراد SRT للمشروع\n';
                msg += '✓ تم إنشاء مسار الترجمات\n';
                msg += '✓ تم إنشاء العلامات على التايملاين';
                showStatus(msg, 'success');
            } else {
                msg = '✓ تم حفظ ملف SRT\n';
                msg += 'ℹ ' + (importData.message || 'قد تحتاج استيراد يدوي');
                showStatus(msg, 'info');
            }
            
            setTimeout(function() {
                showProgress(false);
            }, 1000);
        });
    });
}

function showImportButton() {
    var btn = document.getElementById('btn_import_captions');
    if (btn) {
        btn.style.display = 'flex';
        btn.disabled = false;
    }
}

function hideImportButton() {
    var btn = document.getElementById('btn_import_captions');
    if (btn) {
        btn.style.display = 'none';
    }
}

// ─── SRT Generation ────────────────────────────────────────────

function createSRT(segments) {
    var srt = '';
    for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        srt += (i + 1) + '\n';
        srt += formatSRTTime(s.start) + ' --> ' + formatSRTTime(s.end) + '\n';
        srt += s.text + '\n\n';
    }
    return srt;
}

function formatSRTTime(sec) {
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var ms = Math.floor((sec % 1) * 1000);
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
}

function formatDuration(sec) {
    if (!sec) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + pad(s, 2);
}

function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
}

// ─── UI Updates ────────────────────────────────────────────────

function showCaptionPreview(segments) {
    var container = document.getElementById('caption_preview');
    var list = document.getElementById('caption_list');
    if (!container || !list) return;
    
    list.innerHTML = '';
    var count = Math.min(segments.length, 10);
    
    for (var i = 0; i < count; i++) {
        var seg = segments[i];
        var item = document.createElement('div');
        item.className = 'caption-item';
        
        var time = document.createElement('div');
        time.className = 'caption-time';
        time.textContent = formatSRTTime(seg.start) + ' → ' + formatSRTTime(seg.end);
        
        var text = document.createElement('div');
        text.className = 'caption-text';
        
        // Show low-confidence words in orange if available
        if (seg.words && seg.words.length > 0) {
            seg.words.forEach(function(w) {
                var span = document.createElement('span');
                span.textContent = w.text + ' ';
                if (w.lowConfidence) {
                    span.style.color = '#FF9800';
                    span.style.textDecoration = 'underline dotted';
                    span.title = 'الثقة: ' + Math.round(w.confidence * 100) + '%';
                }
                text.appendChild(span);
            });
        } else {
            text.textContent = seg.text;
        }
        
        item.appendChild(time);
        item.appendChild(text);
        list.appendChild(item);
    }
    
    if (segments.length > count) {
        var more = document.createElement('div');
        more.className = 'caption-item';
        more.innerHTML = '<span style="color:var(--text-muted);"> ... و ' + (segments.length - count) + ' مقاطع أخرى </span>';
        list.appendChild(more);
    }
    
    container.style.display = 'block';
}

function hideCaptionPreview() {
    var el = document.getElementById('caption_preview');
    if (el) el.style.display = 'none';
}

function updateProgress(pct, msg) {
    pct = Math.round(pct);
    var bar = document.getElementById('progress_bar');
    var text = document.getElementById('progress_text');
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = pct + '% — ' + msg;
    log('Progress: ' + pct + '% ' + msg);
}

function showProgress(show) {
    var el = document.getElementById('progress_section');
    if (el) el.style.display = show ? 'block' : 'none';
}

function showStatus(msg, type) {
    var a = document.getElementById('status_area');
    if (a) {
        a.className = 'status-area status-' + type;
        var m = document.getElementById('status_message');
        if (m) m.textContent = msg;
    }
}

function hideStatus() {
    var el = document.getElementById('status_area');
    if (el) el.className = 'status-area';
}

function finishWithError(msg) {
    logError(msg);
    showStatus('خطأ: ' + msg, 'error');
    finishProcessing();
}

function finishProcessing() {
    isProcessing = false;
    cancelRequested = false;
    setButtonState(true);
    setTimeout(function() {
        showProgress(false);
    }, 1000);
    updateActiveSequence();
    checkModelStatus();
}

function setButtonState(enabled) {
    var btn = document.getElementById('btn_generate_captions');
    if (btn) {
        btn.disabled = !enabled;
        if (enabled) {
            btn.innerHTML = '<span class="action-icon">🚀</span> توليد الترجمات (بدون إنترنت)';
        } else {
            btn.innerHTML = '<span class="action-icon spinner">⏳</span> جاري المعالجة...';
        }
    }
}

function onAppThemeColorChanged() {
    updateThemeWithAppSkinInfo(csInterface.hostEnvironment.appSkinInfo);
}

function updateThemeWithAppSkinInfo(s) {
    if (!s) return;
    var bg = s.panelBackgroundColor.color;
    var el = document.getElementById('hostStyle');
    if (el) {
        var fc = bg.red > 127 ? '#000' : '#FFF';
        el.textContent = '.default{color:' + fc + ';background-color:' + toHex(bg) + ';}';
    }
}

function toHex(c, d) {
    function v(x, d) {
        var r = d ? x + d : x;
        r = Math.max(0, Math.min(255, Math.round(r)));
        var h = r.toString(16);
        return h.length === 1 ? '0' + h : h;
    }
    return '#' + v(c.red, d) + v(c.green, d) + v(c.blue, d);
}

// ─── EDITOR STATE ──────────────────────────────────────────────

var editorSegments = [];
var editorSelectedIndex = -1;
var editorHistory = [];
var editorFuture = [];
var editorDirty = false;

function openEditor(segments) {
    editorSegments = JSON.parse(JSON.stringify(segments));
    editorSelectedIndex = segments.length > 0 ? 0 : -1;
    editorHistory = [];
    editorFuture = [];
    editorDirty = false;
    
    var panel = document.getElementById('editor_panel');
    if (panel) panel.style.display = 'block';
    
    renderEditorList();
    updateEditorStats();
    log('Editor opened with ' + editorSegments.length + ' captions');
}

function closeEditor() {
    if (editorDirty) {
        if (!confirm('توجد تعديلات غير محفوظة. هل تريد الإغلاق؟')) return;
    }
    var panel = document.getElementById('editor_panel');
    if (panel) panel.style.display = 'none';
    editorSelectedIndex = -1;
}

function editorPushHistory() {
    editorHistory.push(JSON.stringify(editorSegments));
    if (editorHistory.length > 100) editorHistory.shift();
    editorFuture = [];
    editorDirty = true;
}

function editorUndo() {
    if (editorHistory.length === 0) return;
    editorFuture.push(JSON.stringify(editorSegments));
    editorSegments = JSON.parse(editorHistory.pop());
    renderEditorList();
    updateEditorStats();
}

function editorRedo() {
    if (editorFuture.length === 0) return;
    editorHistory.push(JSON.stringify(editorSegments));
    editorSegments = JSON.parse(editorFuture.pop());
    renderEditorList();
    updateEditorStats();
}

function updateEditorStats() {
    var totalWords = 0;
    var totalChars = 0;
    var totalDur = 0;
    
    editorSegments.forEach(function(s) {
        totalWords += s.text.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
        totalChars += s.text.length;
        totalDur = Math.max(totalDur, s.end || 0);
    });
    
    var statsEl = document.getElementById('editor_stats');
    if (statsEl) {
        statsEl.textContent = editorSegments.length + ' ترجمة · ' + totalWords + ' كلمة · ' + totalChars + ' حرف · ' + formatDuration(totalDur);
    }
}

function renderEditorList() {
    var list = document.getElementById('editor_caption_list');
    if (!list) return;
    
    list.innerHTML = '';
    var searchTerm = '';
    var searchEl = document.getElementById('editor_search');
    if (searchEl) searchTerm = searchEl.value.toLowerCase();
    
    for (var i = 0; i < editorSegments.length; i++) {
        var seg = editorSegments[i];
        
        // Filter by search
        if (searchTerm && seg.text.toLowerCase().indexOf(searchTerm) === -1) continue;
        
        var item = document.createElement('div');
        item.className = 'editor-caption-item' + (i === editorSelectedIndex ? ' selected' : '');
        item.setAttribute('data-index', i);
        
        var time = document.createElement('div');
        time.className = 'cap-time';
        time.textContent = formatSRTTime(seg.start) + ' → ' + formatSRTTime(seg.end);
        
        var text = document.createElement('div');
        text.className = 'cap-text';
        text.textContent = seg.text.length > 60 ? seg.text.substring(0, 60) + '...' : seg.text;
        
        // Warn if text is too long
        if (seg.text.length > 80) {
            var warn = document.createElement('span');
            warn.style.cssText = 'color:#FF9800;font-size:9px;margin-right:4px;';
            warn.textContent = ' (' + seg.text.length + ' حرف — طويل)';
            text.appendChild(warn);
        }
        
        item.appendChild(time);
        item.appendChild(text);
        
        (function(idx) {
            item.addEventListener('click', function() {
                editorSelectCaption(idx);
            });
            item.addEventListener('dblclick', function(e) {
                e.stopPropagation();
                editorEditCaption(idx);
            });
        })(i);
        
        list.appendChild(item);
    }
    
    // Update preview
    if (editorSelectedIndex >= 0 && editorSelectedIndex < editorSegments.length) {
        var selSeg = editorSegments[editorSelectedIndex];
        var preview = document.getElementById('editor_active_text');
        if (preview) preview.textContent = selSeg.text || 'معاينة النص';
        
        var timeStart = document.getElementById('editor_time_start');
        var timeEnd = document.getElementById('editor_time_end');
        var textInput = document.getElementById('editor_text_input');
        
        if (timeStart) timeStart.value = formatSRTTime(selSeg.start);
        if (timeEnd) timeEnd.value = formatSRTTime(selSeg.end);
        if (textInput) textInput.value = selSeg.text;
    }
}

function editorSelectCaption(idx) {
    editorSelectedIndex = idx;
    renderEditorList();
}

function editorEditCaption(idx) {
    editorSelectedIndex = idx;
    renderEditorList();
    var textInput = document.getElementById('editor_text_input');
    if (textInput) textInput.focus();
}

function editorUpdateText() {
    if (editorSelectedIndex < 0) return;
    var textInput = document.getElementById('editor_text_input');
    if (!textInput) return;
    
    editorPushHistory();
    editorSegments[editorSelectedIndex].text = textInput.value;
    
    // Update preview
    var preview = document.getElementById('editor_active_text');
    if (preview) preview.textContent = textInput.value || 'معاينة النص';
    
    updateEditorStats();
}

function editorUpdateTiming() {
    if (editorSelectedIndex < 0) return;
    
    var timeStart = document.getElementById('editor_time_start');
    var timeEnd = document.getElementById('editor_time_end');
    if (!timeStart || !timeEnd) return;
    
    editorPushHistory();
    editorSegments[editorSelectedIndex].start = parseTimestamp(timeStart.value);
    editorSegments[editorSelectedIndex].end = parseTimestamp(timeEnd.value);
    
    renderEditorList();
}

function editorAddCaption() {
    editorPushHistory();
    var lastEnd = editorSegments.length > 0 ? editorSegments[editorSegments.length - 1].end : 0;
    editorSegments.push({
        start: lastEnd,
        end: lastEnd + 2,
        text: '',
        words: [],
        confidence: 1.0
    });
    editorSelectedIndex = editorSegments.length - 1;
    renderEditorList();
    setTimeout(function() {
        editorEditCaption(editorSelectedIndex);
    }, 50);
}

function editorDuplicateCaption() {
    if (editorSelectedIndex < 0) return;
    editorPushHistory();
    var copy = JSON.parse(JSON.stringify(editorSegments[editorSelectedIndex]));
    copy.start = copy.end;
    copy.end = copy.start + 2;
    editorSegments.splice(editorSelectedIndex + 1, 0, copy);
    editorSelectedIndex++;
    renderEditorList();
}

function editorDeleteCaption() {
    if (editorSelectedIndex < 0) return;
    editorPushHistory();
    editorSegments.splice(editorSelectedIndex, 1);
    if (editorSelectedIndex >= editorSegments.length) {
        editorSelectedIndex = editorSegments.length - 1;
    }
    renderEditorList();
    updateEditorStats();
}

function editorMergeCaption() {
    if (editorSelectedIndex < 0 || editorSelectedIndex >= editorSegments.length - 1) return;
    editorPushHistory();
    var a = editorSegments[editorSelectedIndex];
    var b = editorSegments[editorSelectedIndex + 1];
    a.text = a.text + ' ' + b.text;
    a.end = b.end;
    if (a.words && b.words) a.words = a.words.concat(b.words);
    editorSegments.splice(editorSelectedIndex + 1, 1);
    renderEditorList();
    updateEditorStats();
}

function editorSplitCaption() {
    if (editorSelectedIndex < 0) return;
    var seg = editorSegments[editorSelectedIndex];
    var midPoint = seg.text.length / 2;
    var splitIdx = seg.text.lastIndexOf(' ', midPoint);
    if (splitIdx <= 0) splitIdx = Math.floor(midPoint);
    
    editorPushHistory();
    var firstHalf = seg.text.substring(0, splitIdx).trim();
    var secondHalf = seg.text.substring(splitIdx).trim();
    var midTime = (seg.start + seg.end) / 2;
    
    seg.text = firstHalf;
    seg.end = midTime;
    
    var newSeg = {
        start: midTime,
        end: editorSegments[editorSelectedIndex].end + (seg.end - seg.start),
        text: secondHalf,
        words: [],
        confidence: 1.0
    };
    
    editorSegments.splice(editorSelectedIndex + 1, 0, newSeg);
    renderEditorList();
    updateEditorStats();
}

function editorExportSRT() {
    if (editorSegments.length === 0) {
        showStatus('لا توجد ترجمات للتصدير.', 'error');
        return;
    }
    
    var srtContent = '\uFEFF' + createSRT(editorSegments);
    var srtPath = path.join(os.tmpdir(), 'msc_export_' + Date.now() + '.srt');
    
    try {
        fs.writeFileSync(srtPath, srtContent, 'utf8');
        
        // Open file location
        if (process.platform === 'win32') {
            childProcess.exec('explorer /select,"' + srtPath + '"');
        }
        
        showStatus('✓ تم تصدير SRT بنجاح!\n\n' + srtPath, 'success');
    } catch (e) {
        showStatus('فشل التصدير: ' + e.message, 'error');
    }
}

function editorSaveToPremiere() {
    if (editorSegments.length === 0) {
        showStatus('لا توجد ترجمات للحفظ.', 'error');
        return;
    }
    
    // Update lastTranscriptionResult with edited segments
    if (lastTranscriptionResult) {
        lastTranscriptionResult.segments = editorSegments;
    } else {
        lastTranscriptionResult = {
            success: true,
            segments: editorSegments,
            duration: editorSegments[editorSegments.length - 1].end
        };
    }
    
    importCaptionsToPremiere();
    editorDirty = false;
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 'z') {
        editorUndo();
    } else if (e.ctrlKey && e.key === 'y') {
        editorRedo();
    } else if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        editorSaveToPremiere();
    } else if (e.key === 'Delete' && editorSelectedIndex >= 0) {
        editorDeleteCaption();
    } else if (e.key === 'ArrowUp' && editorSelectedIndex > 0) {
        editorSelectCaption(editorSelectedIndex - 1);
    } else if (e.key === 'ArrowDown' && editorSelectedIndex < editorSegments.length - 1) {
        editorSelectCaption(editorSelectedIndex + 1);
    } else if (e.key === 'Enter' && editorSelectedIndex >= 0) {
        e.preventDefault();
        editorEditCaption(editorSelectedIndex);
    }
});

// ─── STYLE FUNCTIONS ───────────────────────────────────────────

function applyFont() {
    var preview = document.getElementById('editor_active_text');
    if (!preview) return;
    
    var fontFamily = document.getElementById('font_family');
    var fontSize = document.getElementById('font_size');
    var fontWeight = document.getElementById('font_weight');
    var fontSizeValue = document.getElementById('font_size_value');
    
    if (fontFamily) preview.style.fontFamily = fontFamily.value;
    if (fontSize) {
        preview.style.fontSize = fontSize.value + 'px';
        if (fontSizeValue) fontSizeValue.textContent = fontSize.value + 'px';
    }
    if (fontWeight) preview.style.fontWeight = fontWeight.value;
}

function applyColor() {
    var preview = document.getElementById('editor_active_text');
    var textColor = document.getElementById('text_color');
    if (preview && textColor) preview.style.color = textColor.value;
}

function applyHighlight() {
    var highlightColor = document.getElementById('highlight_color');
    log('Highlight color: ' + (highlightColor ? highlightColor.value : 'N/A'));
}

function applyStroke() {
    var preview = document.getElementById('editor_active_text');
    if (!preview) return;
    
    var hasStroke = document.getElementById('has_stroke');
    var strokeColor = document.getElementById('stroke_color');
    var strokeWidth = document.getElementById('stroke_width');
    var strokeWidthVal = document.getElementById('stroke_width_val');
    
    if (hasStroke && hasStroke.checked) {
        var c = strokeColor ? strokeColor.value : '#000';
        var w = strokeWidth ? strokeWidth.value : 2;
        preview.style.webkitTextStroke = w + 'px ' + c;
        if (strokeWidthVal) strokeWidthVal.textContent = w + 'px';
    } else {
        preview.style.webkitTextStroke = '';
    }
}

function applyGlow() {
    var preview = document.getElementById('editor_active_text');
    if (!preview) return;
    
    var hasGlow = document.getElementById('has_glow');
    var glowColor = document.getElementById('glow_color');
    
    if (hasGlow && hasGlow.checked) {
        var c = glowColor ? glowColor.value : '#2680EB';
        preview.style.textShadow = '0 0 10px ' + c + ', 0 0 20px ' + c;
    } else {
        preview.style.textShadow = '0 2px 8px rgba(0,0,0,0.8)';
    }
}

function applyBgBox() {
    var preview = document.getElementById('editor_active_text');
    if (!preview) return;
    
    var bgBox = document.getElementById('bg_box');
    var bgColor = document.getElementById('bg_color');
    var cornerRadius = document.getElementById('corner_radius');
    var cornerVal = document.getElementById('corner_val');
    
    if (bgBox && bgBox.checked) {
        preview.style.backgroundColor = bgColor ? bgColor.value : '#000';
        var r = cornerRadius ? cornerRadius.value : 6;
        preview.style.borderRadius = r + 'px';
        if (cornerVal) cornerVal.textContent = r + 'px';
    } else {
        preview.style.backgroundColor = '';
        preview.style.borderRadius = '';
    }
}

function applyPosition() {
    var posX = document.getElementById('pos_x');
    var posY = document.getElementById('pos_y');
    var posXVal = document.getElementById('pos_x_val');
    var posYVal = document.getElementById('pos_y_val');
    
    if (posX && posXVal) posXVal.textContent = posX.value + '%';
    if (posY && posYVal) posYVal.textContent = posY.value + '%';
}

function applyScale() {
    var scaleVal = document.getElementById('scale_val');
    var scaleDisplay = document.getElementById('scale_display');
    var preview = document.getElementById('editor_active_text');
    
    if (scaleVal && scaleDisplay) {
        scaleDisplay.textContent = scaleVal.value + '%';
        if (preview) preview.style.transform = 'scale(' + (scaleVal.value / 100) + ')';
    }
}

function applyRotation() {
    var rotationVal = document.getElementById('rotation_val');
    var rotationDisplay = document.getElementById('rotation_display');
    
    if (rotationVal && rotationDisplay) {
        rotationDisplay.textContent = rotationVal.value + '°';
    }
}

function applyWordHighlight() {
    var wordScale = document.getElementById('word_scale');
    var wordScaleVal = document.getElementById('word_scale_val');
    
    if (wordScale && wordScaleVal) {
        wordScaleVal.textContent = wordScale.value + '%';
    }
}

function applyPreset(name) {
    var preview = document.getElementById('editor_active_text');
    if (!preview) return;
    
    // Reset
    preview.style.cssText = 'font-size:18px;font-weight:600;color:#FFF;text-align:center;line-height:1.3;padding:8px 12px;text-shadow:0 2px 8px rgba(0,0,0,0.8);max-width:100%;word-break:break-word;';
    
    switch (name) {
        case 'tiktok':
            preview.style.fontWeight = '900';
            preview.style.fontSize = '28px';
            preview.style.textTransform = 'uppercase';
            preview.style.webkitTextStroke = '2px #000';
            break;
        case 'podcast':
            preview.style.fontWeight = '400';
            preview.style.fontSize = '20px';
            preview.style.fontStyle = 'italic';
            preview.style.backgroundColor = '#000000AA';
            preview.style.borderRadius = '6px';
            break;
        case 'mrbeast':
            preview.style.fontWeight = '900';
            preview.style.fontSize = '32px';
            preview.style.color = '#FFD700';
            preview.style.webkitTextStroke = '3px #000';
            preview.style.textTransform = 'uppercase';
            break;
        case 'modern':
            preview.style.fontWeight = '600';
            preview.style.fontSize = '22px';
            preview.style.backgroundColor = '#2680EBCC';
            preview.style.borderRadius = '8px';
            preview.style.padding = '10px 16px';
            break;
        case 'gaming':
            preview.style.fontWeight = '900';
            preview.style.fontSize = '26px';
            preview.style.color = '#0F0';
            preview.style.textShadow = '0 0 10px #0F0, 0 0 20px #0F0';
            break;
        case 'cinema':
            preview.style.fontWeight = '300';
            preview.style.fontSize = '18px';
            preview.style.letterSpacing = '2px';
            preview.style.color = '#FFFFFFCC';
            break;
        case 'minimal':
            preview.style.fontWeight = '400';
            preview.style.fontSize = '16px';
            preview.style.color = '#FFFFFF99';
            break;
    }
    
    log('Preset applied: ' + name);
}

// Filter captions function
function filterCaptions() {
    renderEditorList();
}
