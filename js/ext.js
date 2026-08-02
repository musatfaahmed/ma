/**
 * Mostafa Style Caption - Local Offline Speech-to-Text & Premiere Pro Editor
 *
 * Uses whisper.cpp (offline) + bundled FFmpeg for audio conversion.
 * Dynamic Windows font detection via Registry & filesystem.
 * Real-time WYSIWYG caption editor & direct Premiere timeline integration.
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
var EXT_DIR = '';
var BIN_DIR = '';
var MODELS_DIR = '';
var WHISPER_EXE = '';
var FFMPEG_EXE = '';

// Model download URLs (HuggingFace, whisper.cpp GGML format)
var MODEL_URLS = {
    'tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    'base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    'medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    'large-v3': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
};

var MODEL_FILENAMES = {
    'tiny': 'ggml-tiny.bin',
    'base': 'ggml-base.bin',
    'small': 'ggml-small.bin',
    'medium': 'ggml-medium.bin',
    'large-v3': 'ggml-large-v3.bin'
};

// System installed fonts cache
var detectedSystemFonts = [];

function log(m) { console.log('[MSC] ' + m); }
function logError(m) { console.error('[MSC ERROR] ' + m); }

/* ─── Initialization ──────────────────────────────────────────── */
function onLoaded() {
    csInterface = new CSInterface();

    try {
        EXT_DIR = csInterface.getSystemPath(SystemPath.EXTENSION);
    } catch (e) {
        logError('getSystemPath failed: ' + e.message);
        EXT_DIR = '';
    }

    if (nodeEnabled) {
        try {
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

            try { mkdirp(userDataDir); mkdirp(BIN_DIR); mkdirp(MODELS_DIR); } catch (e) { logError('Cannot create data dirs: ' + e.message); }

            // Copy bundled binaries if available
            var bundledWhisper = path.join(EXT_DIR, 'bin', 'whisper-cli.exe');
            var bundledFFmpeg = path.join(EXT_DIR, 'bin', 'ffmpeg.exe');
            try {
                if (!fs.existsSync(WHISPER_EXE) && fs.existsSync(bundledWhisper)) {
                    fs.copyFileSync(bundledWhisper, WHISPER_EXE);
                    var bundledBinDir = path.join(EXT_DIR, 'bin');
                    fs.readdirSync(bundledBinDir).forEach(function(f) {
                        if (f.endsWith('.dll')) {
                            try { fs.copyFileSync(path.join(bundledBinDir, f), path.join(BIN_DIR, f)); } catch (e) {}
                        }
                    });
                }
                if (!fs.existsSync(FFMPEG_EXE) && fs.existsSync(bundledFFmpeg)) {
                    fs.copyFileSync(bundledFFmpeg, FFMPEG_EXE);
                }
            } catch (e) {}
        } catch (e) {
            logError('Path setup failed: ' + e.message);
        }
    }

    try {
        updateThemeWithAppSkinInfo(csInterface.hostEnvironment ? csInterface.hostEnvironment.appSkinInfo : null);
        csInterface.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, onAppThemeColorChanged);
    } catch (e) {}

    updateActiveSequence();
    updateDashboardInfo();

    try {
        csInterface.evalScript('$._MSC_.keepPanelLoaded()');
    } catch (e) {}

    checkAllStatus();
    detectAndPopulateFonts();
    buildAnimationsPage();
}

function mkdirp(dir) {
    if (fs.existsSync(dir)) return;
    var parent = path.dirname(dir);
    if (parent !== dir) mkdirp(parent);
    fs.mkdirSync(dir);
}

function updateActiveSequence() {
    if (!csInterface) return;
    csInterface.evalScript('$._MSC_.getActiveSequenceName()', function(r) {
        var el = document.getElementById('active_seq');
        if (el) el.innerHTML = 'السيكونس النشط: ' + (r || 'لا يوجد سيكونس نشط');
        var dSeq = document.getElementById('dash_sequence');
        if (dSeq) dSeq.textContent = r || '—';
    });
}

function updateDashboardInfo() {
    if (!csInterface) return;
    csInterface.evalScript('$._MSC_.getProjectInfo()', function(res) {
        try {
            var info = JSON.parse(res);
            var dProj = document.getElementById('dash_project');
            if (dProj && info.projectName) dProj.textContent = info.projectName;
            var dSeq = document.getElementById('dash_sequence');
            if (dSeq && info.sequenceName) dSeq.textContent = info.sequenceName;
            var dDur = document.getElementById('dash_duration');
            if (dDur && info.duration) dDur.textContent = formatDuration(info.duration);
        } catch (e) {}
    });
}

/* ═══════════════════════════════════════════════════════════════
   2. WINDOWS FONT DETECTION
   ---------------------------------------------------------------
   Adobe Premiere Pro supports all TrueType (.ttf) and OpenType (.otf)
   fonts installed on Windows (stored in Windows Registry and C:\Windows\Fonts).
   We query the registry to detect all installed font family names
   dynamically and populate all font selectors.
   ═══════════════════════════════════════════════════════════════ */

function detectAndPopulateFonts() {
    // Standard baseline typography fonts (Arabic & Latin)
    var standardFonts = [
        'Cairo', 'Tajawal', 'Almarai', 'Dubai', 'Amiri', 'Traditional Arabic',
        'Simplified Arabic', 'Sakkal Majalla', 'Andalus', 'Arabic Typesetting',
        'Segoe UI', 'Arial', 'Arial Black', 'Impact', 'Trebuchet MS', 'Verdana',
        'Georgia', 'Times New Roman', 'Calibri', 'Montserrat', 'Roboto', 'Oswald',
        'Bebas Neue', 'Consolas', 'Courier New', 'Comic Sans MS'
    ];

    if (!nodeEnabled || !childProcess || process.platform !== 'win32') {
        populateFontDropdowns(standardFonts);
        return;
    }

    // Query Windows Registry for all installed font family names
    var cmd = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"';
    childProcess.exec(cmd, { windowsHide: true }, function(err, stdout) {
        var foundFonts = {};
        standardFonts.forEach(function(f) { foundFonts[f] = true; });

        if (!err && stdout) {
            var lines = stdout.split('\n');
            lines.forEach(function(line) {
                line = line.trim();
                if (!line || line.indexOf('REG_SZ') === -1) return;
                var fontKey = line.split('REG_SZ')[0].trim();
                // Clean registry font format: "Arial (TrueType)" -> "Arial"
                var fontName = fontKey.replace(/\s*\([^)]*\)/g, '')
                                      .replace(/\s*&\s*.*$/, '')
                                      .replace(/Bold|Italic|Regular|Light|Medium|Black|Semibold|ExtraBold/gi, '')
                                      .trim();
                if (fontName && fontName.length > 1) {
                    foundFonts[fontName] = true;
                }
            });
        }

        // Also query User fonts registry on Windows 10/11
        var userCmd = 'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"';
        childProcess.exec(userCmd, { windowsHide: true }, function(uErr, uStdout) {
            if (!uErr && uStdout) {
                var uLines = uStdout.split('\n');
                uLines.forEach(function(uLine) {
                    uLine = uLine.trim();
                    if (!uLine || uLine.indexOf('REG_SZ') === -1) return;
                    var uFontKey = uLine.split('REG_SZ')[0].trim();
                    var uFontName = uFontKey.replace(/\s*\([^)]*\)/g, '')
                                            .replace(/\s*&\s*.*$/, '')
                                            .replace(/Bold|Italic|Regular|Light|Medium|Black|Semibold|ExtraBold/gi, '')
                                            .trim();
                    if (uFontName && uFontName.length > 1) {
                        foundFonts[uFontName] = true;
                    }
                });
            }

            var fontList = Object.keys(foundFonts).sort(function(a, b) {
                return a.localeCompare(b);
            });

            detectedSystemFonts = fontList;
            log('Detected ' + fontList.length + ' Windows fonts available to Premiere');
            populateFontDropdowns(fontList);
        });
    });
}

function populateFontDropdowns(fontList) {
    var targets = ['e_font', 'font_family', 'default_font'];
    targets.forEach(function(id) {
        var sel = document.getElementById(id);
        if (!sel) return;
        var currentVal = sel.value || 'Segoe UI';
        sel.innerHTML = '';
        fontList.forEach(function(f) {
            var opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            if (f === currentVal || f === 'Cairo' && currentVal === 'Cairo') {
                opt.selected = true;
            }
            sel.appendChild(opt);
        });
        if (sel.value !== currentVal && currentVal) {
            sel.value = currentVal;
        }
    });
}

/* ─── Status diagnostics ──────────────────────────────────────── */
function checkAllStatus() {
    if (!nodeEnabled || !fs || !path) {
        setDiag('diag_ffmpeg', 'missing', 'FFmpeg: Node.js غير مفعّل');
        setDiag('diag_whisper', 'missing', 'Whisper: Node.js غير مفعّل');
        setDiag('diag_model', 'missing', 'النموذج: Node.js غير مفعّل');
        return;
    }
    var model = (document.getElementById('model_size') || {}).value || 'base';
    var modelFile = path.join(MODELS_DIR, MODEL_FILENAMES[model] || 'ggml-base.bin');
    var whisperOK = fs.existsSync(WHISPER_EXE);
    var ffmpegOK = fs.existsSync(FFMPEG_EXE);
    var modelOK = fs.existsSync(modelFile);

    setDiag('diag_ffmpeg', ffmpegOK ? 'ok' : 'missing', 'FFmpeg: ' + (ffmpegOK ? 'مُثبّت ✓' : 'غير موجود — سيتم التحميل تلقائياً'));
    setDiag('diag_whisper', whisperOK ? 'ok' : 'missing', 'Whisper: ' + (whisperOK ? 'مُثبّت ✓' : 'غير موجود — سيتم التحميل تلقائياً'));
    setDiag('diag_model', modelOK ? 'ok' : 'missing', 'النموذج (' + model + '): ' + (modelOK ? 'جاهز ✓' : 'سيتم التحميل عند أول استخدام'));
}

function setDiag(id, state, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'diag-row ' + state;
    while (el.firstChild) el.removeChild(el.firstChild);
    var dot = document.createElement('span');
    dot.className = 'diag-dot';
    el.appendChild(dot);
    el.appendChild(document.createTextNode(' ' + text));
}

function checkModelStatus() { checkAllStatus(); }

/* ═══════════════════════════════════════════════════════════════
   MAIN PIPELINE (Whisper.cpp + FFmpeg)
   ═══════════════════════════════════════════════════════════════ */

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
    updateProgress(2, 'جاري فحص وتجهيز المكونات...');

    ensureBinaries(function(binOK) {
        if (!binOK) {
            finishWithError('فشل تجهيز whisper أو ffmpeg.\nتأكد من اتصال الإنترنت وحاول مجدداً.\nالمسار:\n' + BIN_DIR);
            return;
        }
        if (cancelRequested) { finishWithError('تم الإلغاء.'); return; }

        var modelFile = path.join(MODELS_DIR, MODEL_FILENAMES[modelSize]);
        if (fs.existsSync(modelFile)) {
            log('Model ready: ' + modelFile);
            startTranscription(modelFile, language);
        } else {
            downloadModel(modelSize, function(dlOK) {
                if (!dlOK) { finishWithError('فشل تحميل النموذج. تأكد من اتصال الإنترنت.'); return; }
                if (cancelRequested) { finishWithError('تم الإلغاء.'); return; }
                startTranscription(modelFile, language);
            });
        }
    });
}

function ensureBinaries(callback) {
    var whisperOK = fs.existsSync(WHISPER_EXE);
    var ffmpegOK = fs.existsSync(FFMPEG_EXE);
    if (whisperOK && ffmpegOK) { callback(true); return; }

    var steps = [];
    if (!whisperOK) steps.push('whisper');
    if (!ffmpegOK) steps.push('ffmpeg');
    var currentStep = 0;

    function nextStep() {
        if (currentStep >= steps.length) {
            var wOK = fs.existsSync(WHISPER_EXE);
            var fOK = fs.existsSync(FFMPEG_EXE);
            checkAllStatus();
            callback(wOK && fOK);
            return;
        }
        var step = steps[currentStep++];
        if (step === 'whisper') {
            downloadWhisperBinary(function(ok) { if (!ok) { callback(false); return; } nextStep(); });
        } else if (step === 'ffmpeg') {
            downloadFFmpegBinary(function(ok) { if (!ok) { callback(false); return; } nextStep(); });
        }
    }
    nextStep();
}

function downloadWhisperBinary(callback) {
    var zipUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip';
    var zipPath = path.join(os.tmpdir(), 'msc_whisper_' + Date.now() + '.zip');
    var extractDir = path.join(os.tmpdir(), 'msc_whisper_extract_' + Date.now());

    updateProgress(3, 'جاري تحميل whisper-cli.exe...');
    downloadFile(zipUrl, zipPath, function(pct) {
        updateProgress(3 + Math.round(pct * 0.04), 'جاري تحميل Whisper... ' + pct + '%');
    }, function(err) {
        if (err) { callback(false); return; }
        updateProgress(8, 'جاري فك الضغط whisper-cli.exe...');
        var psCmd = 'powershell -NoProfile -Command "Expand-Archive -Path \'' + zipPath.replace(/'/g, "''") + '\' -DestinationPath \'' + extractDir.replace(/'/g, "''") + '\' -Force"';
        childProcess.exec(psCmd, { timeout: 60000 }, function(error) {
            try { fs.unlinkSync(zipPath); } catch (e) {}
            if (error) { callback(false); return; }
            var found = findFileRecursive(extractDir, 'whisper-cli.exe');
            if (found) {
                try {
                    fs.copyFileSync(found, WHISPER_EXE);
                    var srcDir = path.dirname(found);
                    fs.readdirSync(srcDir).filter(function(f) { return f.endsWith('.dll'); }).forEach(function(dll) {
                        try { fs.copyFileSync(path.join(srcDir, dll), path.join(BIN_DIR, dll)); } catch (e) {}
                    });
                } catch (e) { cleanDir(extractDir); callback(false); return; }
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

    updateProgress(9, 'جاري تحميل ffmpeg.exe...');
    downloadFile(zipUrl, zipPath, function(pct) {
        updateProgress(9 + Math.round(pct * 0.06), 'جاري تحميل FFmpeg... ' + pct + '%');
    }, function(err) {
        if (err) { callback(false); return; }
        updateProgress(16, 'جاري فك ضغط ffmpeg.exe...');
        var psCmd = 'powershell -NoProfile -Command "Expand-Archive -Path \'' + zipPath.replace(/'/g, "''") + '\' -DestinationPath \'' + extractDir.replace(/'/g, "''") + '\' -Force"';
        childProcess.exec(psCmd, { timeout: 120000 }, function(error) {
            try { fs.unlinkSync(zipPath); } catch (e) {}
            if (error) { callback(false); return; }
            var found = findFileRecursive(extractDir, 'ffmpeg.exe');
            if (found) {
                try { fs.copyFileSync(found, FFMPEG_EXE); } catch (e) { cleanDir(extractDir); callback(false); return; }
            }
            cleanDir(extractDir);
            callback(true);
        });
    });
}

function findFileRecursive(dir, filename) {
    try {
        var entries = fs.readdirSync(dir);
        for (var i = 0; i < entries.length; i++) {
            var full = path.join(dir, entries[i]);
            if (fs.statSync(full).isDirectory()) {
                var res = findFileRecursive(full, filename);
                if (res) return res;
            } else if (entries[i].toLowerCase() === filename.toLowerCase()) {
                return full;
            }
        }
    } catch (e) {}
    return null;
}

function cleanDir(dir) {
    try {
        if (fs.existsSync(dir)) {
            var files = fs.readdirSync(dir);
            files.forEach(function(f) {
                var p = path.join(dir, f);
                if (fs.statSync(p).isDirectory()) cleanDir(p);
                else fs.unlinkSync(p);
            });
            fs.rmdirSync(dir);
        }
    } catch (e) {}
}

function downloadModel(modelSize, callback) {
    var url = MODEL_URLS[modelSize];
    var dest = path.join(MODELS_DIR, MODEL_FILENAMES[modelSize]);
    var tempDest = dest + '.tmp';
    updateProgress(12, 'جاري تحميل نموذج Whisper (' + modelSize + ')...');
    downloadFile(url, tempDest, function(pct) {
        updateProgress(12 + Math.round(pct * 0.10), 'جاري تحميل النموذج ' + modelSize + '... ' + pct + '%');
    }, function(err) {
        if (err) { try { fs.unlinkSync(tempDest); } catch (e) {} callback(false); return; }
        try { fs.renameSync(tempDest, dest); callback(true); } catch (e) { callback(false); }
    });
}

function downloadFile(url, destPath, onProgress, onDone) {
    var fileStream = fs.createWriteStream(destPath);
    var done = false;
    function finish(err) { if (done) return; done = true; onDone(err); }

    var parsedUrl = new URL(url);
    var client = parsedUrl.protocol === 'https:' ? https : http;
    var req = client.get(url, { headers: { 'User-Agent': 'MostafaStyleCaption/1.0' } }, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            fileStream.close();
            try { fs.unlinkSync(destPath); } catch (e) {}
            return downloadFile(res.headers.location, destPath, onProgress, onDone);
        }
        if (res.statusCode !== 200) { finish('HTTP ' + res.statusCode); return; }
        var totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        var receivedBytes = 0;
        res.on('data', function(chunk) {
            receivedBytes += chunk.length;
            fileStream.write(chunk);
            if (totalBytes > 0) {
                var pct = Math.round((receivedBytes / totalBytes) * 100);
                onProgress(pct);
            }
        });
        res.on('end', function() { fileStream.end(function() { finish(null); }); });
        res.on('error', function(e) { finish(e.message); });
    });
    req.on('error', function(e) { finish(e.message); });
}

/* ─── Transcription execution ─────────────────────────────────── */
function startTranscription(modelFile, language) {
    updateProgress(22, 'جاري البحث عن وسائط السيكونس في Premiere...');
    csInterface.evalScript('$._MSC_.getSequenceMediaPath()', function(mediaResult) {
        var mediaData;
        try { mediaData = JSON.parse(mediaResult); } catch (e) { finishWithError('فشل الاتصال بـ Premiere.'); return; }
        if (!mediaData.success) { finishWithError(mediaData.message || 'لا توجد وسائط صوتية في السيكونس.'); return; }

        var sourcePath = mediaData.mediaPath;
        log('Source media: ' + sourcePath);
        if (cancelRequested) { finishWithError('تم الإلغاء.'); return; }

        updateProgress(25, 'جاري تحويل واستخراج الصوت (16 kHz أحادي)...');
        var wavPath = path.join(os.tmpdir(), 'msc_audio_' + Date.now() + '.wav');
        tempFiles.push(wavPath);

        convertAudio(sourcePath, wavPath, function(convErr) {
            if (convErr) { finishWithError('فشل استخراج الصوت عبر FFmpeg:\n' + convErr); return; }
            if (!fs.existsSync(wavPath)) { finishWithError('ملف الصوت المحوّل غير موجود.'); return; }

            updateProgress(35, 'جاري التفريغ بـ Whisper (بدون إنترنت)...');
            runWhisper(wavPath, modelFile, language, function(whisperResult) {
                if (!whisperResult.success) { finishWithError('فشل التفريغ:\n' + whisperResult.message); return; }
                if (cancelRequested) { finishWithError('تم الإلغاء.'); return; }
                handleTranscriptionResult(whisperResult);
            });
        });
    });
}

function convertAudio(inputPath, outputPath, callback) {
    var done = false;
    function finish(err) { if (done) return; done = true; callback(err); }
    var args = ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'wav', outputPath];
    var child = childProcess.spawn(FFMPEG_EXE, args, { windowsHide: true });
    var stderr = '';
    child.stderr.on('data', function(d) { stderr += d.toString(); });
    child.on('error', function(e) { finish('خطأ FFmpeg: ' + e.message); });
    child.on('close', function(code) {
        if (code === 0) finish(null);
        else finish('FFmpeg رمز ' + code + '\n' + stderr.substring(0, 300));
    });
    setTimeout(function() { if (!done && !child.killed) { child.kill(); finish('انتهت مهلة FFmpeg'); } }, 300000);
}

function runWhisper(wavPath, modelPath, language, callback) {
    var done = false;
    function finish(r) { if (done) return; done = true; callback(r); }
    var outputBase = wavPath.replace(/\.wav$/, '');
    var srtPath = outputBase + '.srt';
    var jsonPath = outputBase + '.json';
    tempFiles.push(srtPath);
    tempFiles.push(jsonPath);

    var cpuCount = os.cpus().length;
    var threads = Math.max(2, cpuCount - 1);
    var args = [
        '-m', modelPath, '-f', wavPath,
        '-ojf', '-osrt', '-of', outputBase,
        '-t', String(threads),
        '-bs', '5', '-bo', '5', '-mc', '64', '-ml', '50',
        '-sow', '-wt', '0.01', '-pp', '--no-prints'
    ];

    if (language && language !== 'auto') args.push('-l', language);
    else args.push('-l', 'auto');

    var prompt = language === 'ar' ? 'هذا تسجيل باللغة العربية مع علامات الترقيم.' : 'Transcribe accurately with punctuation.';
    args.push('--prompt', prompt);

    var startTime = Date.now();
    var child = childProcess.spawn(WHISPER_EXE, args, { windowsHide: true });
    var stdout = '';
    child.stdout.on('data', function(d) { stdout += d.toString(); parseProgress(d.toString(), startTime); });
    child.stderr.on('data', function(d) { parseProgress(d.toString(), startTime); });
    child.on('error', function(err) { finish({ success: false, message: 'خطأ تشغيل Whisper: ' + err.message }); });
    child.on('close', function(code) {
        if (code === 0) {
            processWhisperOutput(jsonPath, srtPath, language, finish);
        } else {
            finish({ success: false, message: 'Whisper رمز الخروج ' + code });
        }
    });
}

function parseProgress(text, startTime) {
    var match = text.match(/progress\s*=\s*(\d+)%/i) || text.match(/(\d+)%/);
    if (match) {
        var pct = parseInt(match[1], 10);
        var cur = 35 + Math.round(pct * 0.45);
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        updateProgress(cur, 'جاري تفريغ الصوت... ' + pct + '% (' + elapsed + ' ث)');
    }
}

function processWhisperOutput(jsonPath, srtPath, language, finish) {
    var segments = [];
    var totalWords = 0;
    var lowConf = 0;

    if (fs.existsSync(jsonPath)) {
        try {
            var data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (data.transcription && Array.isArray(data.transcription)) {
                data.transcription.forEach(function(seg) {
                    var sText = (seg.text || '').trim();
                    if (!sText) return;
                    var sStart = parseTimestamp(seg.timestamps.from);
                    var sEnd = parseTimestamp(seg.timestamps.to);
                    var words = [];
                    if (seg.tokens && Array.isArray(seg.tokens)) {
                        seg.tokens.forEach(function(tok) {
                            if (!tok.text || !tok.timestamps || tok.id >= 50000) return;
                            var wText = tok.text.trim();
                            if (!wText) return;
                            var conf = typeof tok.p === 'number' ? tok.p : 1.0;
                            words.push({ text: wText, start: parseTimestamp(tok.timestamps.from), end: parseTimestamp(tok.timestamps.to), confidence: conf });
                            totalWords++;
                            if (conf < 0.6) lowConf++;
                        });
                    }
                    segments.push({ start: sStart, end: sEnd, text: sText, words: words, meta: defaultMeta(), _modified: false });
                });
            }
        } catch (e) {}
    }

    if (segments.length === 0 && fs.existsSync(srtPath)) {
        try {
            var raw = fs.readFileSync(srtPath, 'utf8');
            segments = parseSRT(raw);
        } catch (e) {}
    }

    if (segments.length === 0) {
        finish({ success: false, message: 'لم يتم العثور على كلام واضح في السيكونس.' });
        return;
    }

    var dur = segments[segments.length - 1].end || 0;
    finish({ success: true, segments: segments, srtPath: srtPath, duration: dur, totalWords: totalWords, lowConfidenceWords: lowConf });
}

function parseTimestamp(ts) {
    if (typeof ts === 'number') return ts;
    var parts = String(ts).replace(',', '.').split(':');
    if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    return parseFloat(ts) || 0;
}

function parseSRT(srtText) {
    var segments = [];
    var blocks = srtText.trim().split(/\n\s*\n/);
    for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].split('\n');
        if (lines.length >= 3) {
            var timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
            var textLines = lines.slice(2).join(' ').trim();
            if (timeMatch && textLines) {
                segments.push({ start: parseTimestamp(timeMatch[1]), end: parseTimestamp(timeMatch[2]), text: textLines, words: [], meta: defaultMeta(), _modified: false });
            }
        }
    }
    return segments;
}

function cleanupTempFiles() {
    tempFiles.forEach(function(f) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
    tempFiles = [];
}

/* ─── Result handling ─────────────────────────────────────────── */
var lastTranscriptionResult = null;

function handleTranscriptionResult(result) {
    if (!result.success) { cleanupTempFiles(); finishWithError(result.message || 'فشل التفريغ'); return; }
    lastTranscriptionResult = result;
    updateProgress(100, 'اكتمل بنجاح!');

    var msg = '✓ تم توليد الترجمات بنجاح (بدون إنترنت)\n\n';
    msg += 'عدد الكابشن: ' + result.segments.length + '\n';
    msg += 'المدة: ' + formatDuration(result.duration) + '\n';
    if (result.totalWords) msg += 'عدد الكلمات: ' + result.totalWords + '\n';
    showStatus(msg, 'success');

    showCaptionPreview(result.segments);
    showImportButton();
    openEditor(result.segments);
    setTimeout(cleanupTempFiles, 5000);
    finishProcessing();
}

/* ═══════════════════════════════════════════════════════════════
   1. CAPTION IMPORT TO PREMIERE (Highest Priority)
   ---------------------------------------------------------------
   Workflow: Generate Captions -> Review/Edit -> Import to Timeline.
   Imports all captions directly to the active Premiere sequence,
   creates/places subtitle clips on track, and syncs markers.
   ═══════════════════════════════════════════════════════════════ */

function importCaptionsToPremiere() {
    importAllCaptions();
}

function importAllCaptions() {
    if (editorSegments.length === 0) {
        if (!lastTranscriptionResult || !lastTranscriptionResult.segments) {
            showStatus('لا توجد كابشن للاستيراد. قم بتوليد الكابشن أولاً.', 'error');
            return;
        }
        openEditor(lastTranscriptionResult.segments);
    }
    var segments = editorSegments;
    updateProgress(85, 'جاري إرسال واستيراد الكابشن إلى التايملاين في Premiere Pro...');
    showProgress(true);

    var srtPath = path.join(os.tmpdir(), 'msc_captions_' + Date.now() + '.srt');
    var srtContent = '\uFEFF' + createSRT(segments);
    fs.writeFileSync(srtPath, srtContent, 'utf8');
    tempFiles.push(srtPath);

    // 1. Clear own old extension markers
    csInterface.evalScript('$._MSC_.removeOwnCaptionMarkers()', function() {
        // 2. Execute Primary Timeline Import
        var escapedPath = srtPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        csInterface.evalScript("$._MSC_.importSRTAndCreateCaptions('" + escapedPath + "')", function(importResult) {
            var importData;
            try {
                importData = JSON.parse(importResult);
            } catch (e) {
                importData = { success: true, message: importResult, captionCount: segments.length };
            }

            // 3. Mark all segments as clean/saved
            segments.forEach(function(s) { s._modified = false; });
            renderEditorList();

            updateProgress(100, 'تم الاستيراد بنجاح!');
            var msg = '✓ تم استيراد جميع الكابشن إلى التايملاين بنجاح!\n\n';
            msg += '• عدد الكابشن: ' + (importData.captionCount || segments.length) + '\n';
            msg += '• تم الحفاظ على التوقيت والترتيب بدقة\n';
            msg += '• تم إضافة علامات الكابشن المتزامنة مع التايملاين\n';
            if (countAnimations(segments) !== 'بدون') {
                msg += '• الحركات المفعلة: ' + countAnimations(segments);
            }
            showStatus(msg, 'success');
            setTimeout(function() { showProgress(false); }, 1500);
            updateEditorStats();
            updateDashboardInfo();
        });
    });
}

function countAnimations(segments) {
    var n = segments.filter(function(s) { return s.meta && s.meta.animation && s.meta.animation !== 'none'; }).length;
    return n > 0 ? n + ' حركة' : 'بدون';
}

/**
 * "تحديث الكابشن المحدد" — Updates ONLY the selected caption on the Premiere
 * sequence timeline without deleting or modifying any other caption.
 */
function updateSelectedCaption() {
    if (editorSelectedIndex < 0 || !editorSegments.length) {
        showStatus('حدد كابشن أولاً من القائمة لتحديثه.', 'info');
        return;
    }
    var seg = editorSegments[editorSelectedIndex];
    var segJSON = JSON.stringify({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        animation: (seg.meta && seg.meta.animation) || 'none'
    }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    updateProgress(90, 'جاري تحديث الكابشن رقم ' + (editorSelectedIndex + 1) + '...');
    showProgress(true);

    csInterface.evalScript("$._MSC_.updateSingleCaptionMarker(" + editorSelectedIndex + ", '" + segJSON + "')", function(res) {
        var data;
        try { data = JSON.parse(res); } catch (e) { data = { success: true, message: res }; }
        updateProgress(100, 'تم التحديث!');

        var msg = data.success
            ? '✓ تم تحديث الكابشن رقم ' + (editorSelectedIndex + 1) + ' في التايملاين بنجاح\n(تم الحفاظ على التوقيت والموضع وباقي الكابشن)'
            : 'ℹ ' + (data.message || 'تم التحديث');

        showStatus(msg, data.success ? 'success' : 'info');
        setTimeout(function() { showProgress(false); }, 1200);

        seg._modified = false;
        renderEditorList();
    });
}

function showImportButton() {
    var btn = document.getElementById('btn_import_captions');
    if (btn) { btn.style.display = 'flex'; btn.disabled = false; }
}
function hideImportButton() {
    var btn = document.getElementById('btn_import_captions');
    if (btn) btn.style.display = 'none';
}

function createSRT(segments) {
    var srt = '';
    for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        srt += (i + 1) + '\n';
        srt += formatSRTTime(s.start) + ' --> ' + formatSRTTime(s.end) + '\n';
        srt += (s.text || '') + '\n\n';
    }
    return srt;
}

function formatSRTTime(sec) {
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var ms = Math.floor((sec % 1) * 1000);
    function pad(n, len) { var str = String(n); while (str.length < len) str = '0' + str; return str; }
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
}

function formatDuration(sec) {
    if (!sec) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return m + ':' + pad(s);
}

function formatTime(sec) {
    if (isNaN(sec)) return '0:00.0';
    var m = Math.floor(sec / 60);
    var s = (sec % 60).toFixed(1);
    return m + ':' + (parseFloat(s) < 10 ? '0' : '') + s;
}

/* ─── Caption preview (generation result) ─────────────────────── */
function showCaptionPreview(segments) {
    var container = document.getElementById('caption_preview');
    var list = document.getElementById('caption_preview_list');
    if (!container || !list) return;
    list.innerHTML = '';
    var count = Math.min(segments.length, 10);
    for (var i = 0; i < count; i++) {
        var seg = segments[i];
        var item = document.createElement('div');
        item.className = 'caption-item';
        var num = document.createElement('span');
        num.className = 'cap-num';
        num.textContent = (i + 1);
        var time = document.createElement('span');
        time.className = 'cap-time';
        time.textContent = formatTime(seg.start) + ' → ' + formatTime(seg.end);
        var text = document.createElement('span');
        text.className = 'cap-text';
        text.textContent = seg.text;
        item.appendChild(num);
        item.appendChild(time);
        item.appendChild(text);
        (function(idx) {
            item.addEventListener('click', function() {
                if (editorSegments.length) editorSelectCaption(idx);
            });
        })(i);
        list.appendChild(item);
    }
    var countEl = document.getElementById('caption_preview_count');
    if (countEl) countEl.textContent = segments.length + ' كابشن — انقر للمراجعة والتعديل';
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
}

function showProgress(show) {
    var el = document.getElementById('progress_section');
    if (el) el.style.display = show ? 'block' : 'none';
}

function showStatus(msg, type) {
    var a = document.getElementById('status_area');
    if (a) a.className = 'status-area status-' + type;
    var m = document.getElementById('status_message');
    if (m) m.textContent = msg;
    var hs = document.getElementById('header_status_text');
    if (hs) hs.textContent = (type === 'success') ? 'تم بنجاح' : (type === 'error' ? 'خطأ' : 'جاهز');
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
    setTimeout(function() { showProgress(false); }, 1000);
    updateActiveSequence();
    checkModelStatus();
}

function setButtonState(enabled) {
    var btn = document.getElementById('btn_generate_captions');
    if (btn) {
        btn.disabled = !enabled;
        if (enabled) btn.innerHTML = ' 🚀 توليد الترجمات (بدون إنترنت)';
        else btn.innerHTML = ' ⏳ جاري المعالجة...';
    }
}

function onAppThemeColorChanged() {
    updateThemeWithAppSkinInfo(csInterface.hostEnvironment ? csInterface.hostEnvironment.appSkinInfo : null);
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

/* ═══════════════════════════════════════════════════════════════
   5. PROFESSIONAL CAPTION EDITOR
   - Real-time text & timing editing
   - Find & Replace
   - Multi-select captions
   - Apply style: Current / Selected / All
   - Live WYSIWYG preview
   - Safe in-memory edits
   ═══════════════════════════════════════════════════════════════ */

var editorSegments = [];
var editorSelectedIndex = -1;
var selectedSet = {};
var editorHistory = [];
var editorFuture = [];
var editorDirty = false;

/* Supported Animation presets */
var ANIMS = {
    'none':       { label: 'بدون',      key: '' },
    'fade':       { label: 'Fade',      key: 'mscFade' },
    'pop':        { label: 'Pop',       key: 'mscPop' },
    'bounce':     { label: 'Bounce',    key: 'mscBounce' },
    'scale':      { label: 'Scale',     key: 'mscScale' },
    'slide':      { label: 'Slide',     key: 'mscSlide' },
    'zoom':       { label: 'Zoom',      key: 'mscZoom' },
    'glow':       { label: 'Glow',      key: 'mscGlow' },
    'typewriter': { label: 'Typewriter',key: 'mscTypewriter' },
    'highlight':  { label: 'Highlight', key: 'mscHighlight' }
};

function defaultMeta() {
    return {
        fontFamily: (document.getElementById('default_font') || {}).value || 'Segoe UI',
        fontSize: 26,
        fontWeight: 600,
        color: '#ffffff',
        bgEnabled: false,
        bgColor: '#000000',
        bgOpacity: 0.75,
        bgRadius: 6,
        strokeEnabled: false,
        strokeColor: '#000000',
        strokeWidth: 2,
        shadowEnabled: true,
        shadowBlur: 8,
        glowEnabled: false,
        glowColor: '#2680EB',
        align: 'center',
        posX: 50,
        posY: 90,
        scale: 100,
        rotation: 0,
        animation: 'none'
    };
}

function openEditor(segments) {
    editorSegments = JSON.parse(JSON.stringify(segments || []));
    for (var i = 0; i < editorSegments.length; i++) {
        var s = editorSegments[i];
        if (!s.meta) s.meta = defaultMeta();
        s._modified = false;
        s.text = String(s.text || '');
    }
    selectedSet = {};
    editorSelectedIndex = editorSegments.length > 0 ? 0 : -1;
    editorHistory = [];
    editorFuture = [];
    editorDirty = false;

    var panel = document.getElementById('editor_panel');
    if (panel) {
        panel.style.display = 'block';
        buildEditorPanelHTML();
    }
    syncControlsFromSelected();
    renderEditorList();
    updateEditorStats();
    log('Editor opened with ' + editorSegments.length + ' captions');
}

function buildEditorPanelHTML() {
    var panel = document.getElementById('editor_panel');
    if (!panel) return;
    var html = '';

    // Toolbar & Search / Replace
    html += '<div class="editor-toolbar">';
    html += '  <div class="et-title">✏️ محرر الكابشن الاحترافي</div>';
    html += '  <input class="editor-toolbar-search" id="editor_search" type="text" placeholder="🔍 بحث في الكابشن..." oninput="filterCaptions()">';
    html += '  <span class="editor-stats" id="editor_stats"></span>';
    html += '</div>';

    // Find & Replace bar
    html += '<div class="find-replace-bar" style="display:flex;gap:6px;padding:6px 12px;background:var(--panel2);border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap">';
    html += '  <span style="font-size:11px;color:var(--muted)">استبدال:</span>';
    html += '  <input type="text" id="rep_find" placeholder="البحث عن كلمة..." style="width:130px;padding:4px 8px;font-size:11px">';
    html += '  <span style="font-size:11px;color:var(--muted)">بـ:</span>';
    html += '  <input type="text" id="rep_with" placeholder="الكلمة البديلة..." style="width:130px;padding:4px 8px;font-size:11px">';
    html += '  <button class="btn-base btn-ghost btn-sm" onclick="replaceInCurrent()">استبدال المحدد</button>';
    html += '  <button class="btn-base btn-primary btn-sm" onclick="replaceAll()">استبدال في الكل</button>';
    html += '</div>';

    // Body
    html += '<div class="editor-body">';

    // Left column: caption card list
    html += '  <div class="editor-list-col">';
    html += '    <div class="editor-list-header">';
    html += '      <span>قائمة الكابشن</span>';
    html += '      <div style="display:flex;gap:4px">';
    html += '        <button class="btn-base btn-ghost btn-sm" style="padding:2px 6px;font-size:10px" onclick="selectAllCaptions()">تحديد الكل</button>';
    html += '        <button class="btn-base btn-ghost btn-sm" style="padding:2px 6px;font-size:10px" onclick="clearMultiSelect()">إلغاء</button>';
    html += '      </div>';
    html += '    </div>';
    html += '    <div class="caption-list" id="editor_caption_list"></div>';
    html += '    <div class="btn-row" style="padding:8px;border-top:1px solid var(--border);margin-top:0">';
    html += '      <button class="btn-base btn-ghost btn-sm" title="إضافة كابشن جديد" onclick="editorAddCaption()">➕ إضافة</button>';
    html += '      <button class="btn-base btn-ghost btn-sm" title="تكرار الكابشن" onclick="editorDuplicateCaption()">⧉ تكرار</button>';
    html += '      <button class="btn-base btn-danger btn-sm" title="حذف الكابشن" onclick="editorDeleteCaption()">🗑 حذف</button>';
    html += '      <button class="btn-base btn-ghost btn-sm" title="دمج مع التالي" onclick="editorMergeCaption()">⇄ دمج</button>';
    html += '      <button class="btn-base btn-ghost btn-sm" title="تقسيم إلى نصفين" onclick="editorSplitCaption()">✂ تقسيم</button>';
    html += '    </div>';
    html += '  </div>';

    // Right column: inspector & live preview
    html += '  <div class="editor-main-col">';

    // Live preview stage (Premiere-style WYSIWYG)
    html += '    <div class="editor-preview-box" id="editor_preview_box">';
    html += '      <span class="editor-preview-label">معاينة مباشرة (WYSIWYG)</span>';
    html += '      <div class="editor-active-text" id="editor_active_text" style="transform-origin:center"></div>';
    html += '      <span class="editor-preview-hotkey">انقر لتشغيل الحركة</span>';
    html += '    </div>';

    // Apply scope selector
    html += '    <div class="apply-scope">';
    html += '      <span class="scope-label">نطاق تطبيق النمط:</span>';
    html += '      <button class="scope-chip current" id="scope_current" onclick="applyStyleScope(\'current\')">الكابشن الحالي</button>';
    html += '      <button class="scope-chip selected" id="scope_selected" onclick="applyStyleScope(\'selected\')">المحددة (0)</button>';
    html += '      <button class="scope-chip all" id="scope_all" onclick="applyStyleScope(\'all\')">كل الكابشن</button>';
    html += '    </div>';

    // Editor tab buttons
    html += '    <div class="editor-tabs">';
    html += '      <button class="editor-tab active" data-tab="tab_text" onclick="switchEditorTab(\'tab_text\',this)">النص والتوقيت</button>';
    html += '      <button class="editor-tab" data-tab="tab_style" onclick="switchEditorTab(\'tab_style\',this)">الخط والنمط</button>';
    html += '      <button class="editor-tab" data-tab="tab_box" onclick="switchEditorTab(\'tab_box\',this)">الخلفية والحدود</button>';
    html += '      <button class="editor-tab" data-tab="tab_pos" onclick="switchEditorTab(\'tab_pos\',this)">الموضع والمقياس</button>';
    html += '      <button class="editor-tab" data-tab="tab_anim" onclick="switchEditorTab(\'tab_anim\',this)">الحركات</button>';
    html += '    </div>';

    /* Tab 1: Text & Timing */
    html += '    <div class="editor-tab-pane active" id="tab_text">';
    html += '      <div class="field"><label>نص الكابشن (يُحفظ ويُعرض فوراً):</label>';
    html += '        <textarea id="editor_text_area" rows="3" oninput="onTextEdited(this.value)"></textarea></div>';
    html += '      <div class="field-row">';
    html += '        <div class="field"><label>البداية (ثانية):</label><input type="text" id="editor_start" onchange="onTimeEdited(\'start\',this.value)"></div>';
    html += '        <div class="field"><label>النهاية (ثانية):</label><input type="text" id="editor_end" onchange="onTimeEdited(\'end\',this.value)"></div>';
    html += '      </div>';
    html += '      <div class="btn-row">';
    html += '        <button class="btn-base btn-success" onclick="updateSelectedCaption()">🗸 تحديث الكابشن المحدد</button>';
    html += '        <button class="btn-base btn-primary" onclick="importAllCaptions()">📥 إضافة جميع الكابشن</button>';
    html += '      </div>';
    html += '    </div>';

    /* Tab 2: Style & Font */
    html += '    <div class="editor-tab-pane" id="tab_style">';
    html += '      <div class="field"><label>نوع الخط (خطوط Windows و Premiere):</label>';
    html += '        <select id="e_font" onchange="onMetaChange(\'fontFamily\',this.value)"></select></div>';
    html += '      <div class="field"><label>حجم الخط: <span id="e_size_val">26px</span></label><input type="range" id="e_size" min="10" max="80" value="26" oninput="onMetaChange(\'fontSize\',+this.value)"></div>';
    html += '      <div class="field"><label>سُمك الخط:</label><select id="e_weight" onchange="onMetaChange(\'fontWeight\',+this.value)"><option value="300">فاتح (Light)</option><option value="400">عادي (Regular)</option><option value="600" selected>شبه عريض (SemiBold)</option><option value="700">عريض (Bold)</option><option value="900">ثقيل (Black)</option></select></div>';
    html += '      <div class="field"><label>لون النص:</label><input type="color" id="e_color" oninput="onMetaChange(\'color\',this.value)"></div>';
    html += '      <div class="field"><label>المحاذاة:</label><select id="e_align" onchange="onMetaChange(\'align\',this.value)"><option value="left">يسار</option><option value="center" selected>وسط</option><option value="right">يمين</option></select></div>';
    html += '      <div class="field"><label>ظل النص (Shadow):</label><div class="field-inline"><div class="check-row" style="flex:1"><input type="checkbox" id="e_shadow" onchange="onMetaChange(\'shadowEnabled\',this.checked)"><span>تفعيل الظل</span></div>';
    html += '        <label style="font-size:11px">الضبابية: <span id="e_shadow_val">8</span></label><input type="range" id="e_shadowBlur" min="0" max="30" value="8" style="flex:1" oninput="onMetaChange(\'shadowBlur\',+this.value)"></div></div>';
    html += '    </div>';

    /* Tab 3: Box / Stroke / Glow */
    html += '    <div class="editor-tab-pane" id="tab_box">';
    html += '      <div class="field"><label>خلفية الكابشن (Box Background):</label><div class="field-inline"><div class="check-row" style="flex:1"><input type="checkbox" id="e_bg" onchange="onMetaChange(\'bgEnabled\',this.checked)"><span>تفعيل المربع</span></div>';
    html += '        <label style="font-size:11px">اللون</label><input type="color" id="e_bgColor" style="width:40px" oninput="onMetaChange(\'bgColor\',this.value)"></div></div>';
    html += '      <div class="field"><label>شفافية الخلفية: <span id="e_bgOp_val">75%</span></label><input type="range" id="e_bgOp" min="0" max="100" value="75" oninput="onMetaChange(\'bgOpacity\',+this.value / 100)"></div>';
    html += '      <div class="field"><label>انحناء الزوايا: <span id="e_bgRad_val">6px</span></label><input type="range" id="e_bgRad" min="0" max="30" value="6" oninput="onMetaChange(\'bgRadius\',+this.value)"></div>';
    html += '      <div class="field"><label>الحدود الخارجية (Stroke):</label><div class="field-inline"><div class="check-row" style="flex:1"><input type="checkbox" id="e_stroke" onchange="onMetaChange(\'strokeEnabled\',this.checked)"><span>تفعيل المحيط</span></div>';
    html += '        <label style="font-size:11px">السُمك: <span id="e_stroke_w">2px</span></label><input type="range" id="e_strokeWidth" min="0" max="10" value="2" style="flex:1" oninput="onMetaChange(\'strokeWidth\',+this.value)"></div></div>';
    html += '      <div class="field"><label>لون الحدود:</label><input type="color" id="e_strokeColor" oninput="onMetaChange(\'strokeColor\',this.value)"></div>';
    html += '      <div class="field"><label>التوهج النيوني (Glow):</label><div class="field-inline"><div class="check-row" style="flex:1"><input type="checkbox" id="e_glow" onchange="onMetaChange(\'glowEnabled\',this.checked)"><span>تفعيل التوهج</span></div>';
    html += '        <label style="font-size:11px">اللون</label><input type="color" id="e_glowColor" style="width:40px" oninput="onMetaChange(\'glowColor\',this.value)"></div></div>';
    html += '    </div>';

    /* Tab 4: Position & Scale */
    html += '    <div class="editor-tab-pane" id="tab_pos">';
    html += '      <div class="field"><label>الموضع الأفقي (X): <span id="e_px_val">50%</span></label><input type="range" id="e_px" min="0" max="100" value="50" oninput="onMetaChange(\'posX\',+this.value)"></div>';
    html += '      <div class="field"><label>الموضع الرأسي (Y): <span id="e_py_val">90%</span></label><input type="range" id="e_py" min="0" max="100" value="90" oninput="onMetaChange(\'posY\',+this.value)"></div>';
    html += '      <div class="field-row">';
    html += '        <div class="field"><label>المقياس: <span id="e_scale_val">100%</span></label><input type="range" id="e_scale" min="50" max="250" value="100" oninput="onMetaChange(\'scale\',+this.value)"></div>';
    html += '        <div class="field"><label>زاوية الدوران: <span id="e_rot_val">0°</span></label><input type="range" id="e_rot" min="-45" max="45" value="0" oninput="onMetaChange(\'rotation\',+this.value)"></div>';
    html += '      </div>';
    html += '    </div>';

    /* Tab 5: Animations */
    html += '    <div class="editor-tab-pane" id="tab_anim">';
    html += '      <div class="editor-section-title">✨ الحركات المباشرة (Live Animation Presets)</div>';
    html += '      <div class="anim-grid" id="anim_grid">';
    var icons = { none:'—', fade:'👻', pop:'💥', bounce:'🎈', scale:'🔍', slide:'➡️', zoom:'🔎', glow:'🌟', typewriter:'⌨️', highlight:'🖍️' };
    Object.keys(ANIMS).forEach(function(k) {
        html += '      <div class="anim-cell' + (k === 'none' ? ' active' : '') + '" data-anim="' + k + '" onclick="setAnimation(\'' + k + '\')"><span class="anim-icon">' + (icons[k] || '✨') + '</span>' + ANIMS[k].label + '</div>';
    });
    html += '      </div>';
    html += '      <div class="mt8 text-muted" style="font-size:11px">يتم تشغيل الحركة مباشرة في المعاينة وحفظها مع الكابشن عند الاستيراد إلى Premiere.</div>';
    html += '    </div>';

    html += '  </div>';
    html += '</div>';

    panel.innerHTML = html;
    if (detectedSystemFonts.length > 0) {
        populateFontDropdowns(detectedSystemFonts);
    }
}

function switchEditorTab(tabId, btn) {
    document.querySelectorAll('.editor-tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.editor-tab-pane').forEach(function(p) { p.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    var pane = document.getElementById(tabId);
    if (pane) pane.classList.add('active');
}

/* ─── Real-time editing logic ─────────────────────────────────── */
function onTextEdited(value) {
    if (editorSelectedIndex < 0) return;
    var seg = editorSegments[editorSelectedIndex];
    seg.text = value;
    seg._modified = true;
    renderEditorList();
    updatePreviewInstant();
    updateEditorStats();
}

function onTimeEdited(key, value) {
    if (editorSelectedIndex < 0) return;
    var sec = parseFloat(value);
    if (isNaN(sec)) return;
    var seg = editorSegments[editorSelectedIndex];
    if (key === 'start') seg.start = sec;
    else seg.end = sec;
    seg._modified = true;
    var startEl = document.getElementById('editor_start');
    var endEl = document.getElementById('editor_end');
    if (startEl) startEl.value = seg.start.toFixed(2);
    if (endEl) endEl.value = seg.end.toFixed(2);
    renderEditorList();
    updateEditorStats();
}

/* Find & Replace */
function replaceInCurrent() {
    if (editorSelectedIndex < 0) return;
    var findVal = (document.getElementById('rep_find') || {}).value || '';
    var repVal = (document.getElementById('rep_with') || {}).value || '';
    if (!findVal) return;
    var seg = editorSegments[editorSelectedIndex];
    if (seg.text.indexOf(findVal) !== -1) {
        seg.text = seg.text.split(findVal).join(repVal);
        seg._modified = true;
        syncControlsFromSelected();
        renderEditorList();
        showStatus('✓ تم الاستبدال في الكابشن المحدد', 'success');
        setTimeout(hideStatus, 2000);
    }
}

function replaceAll() {
    var findVal = (document.getElementById('rep_find') || {}).value || '';
    var repVal = (document.getElementById('rep_with') || {}).value || '';
    if (!findVal) return;
    var count = 0;
    editorSegments.forEach(function(s) {
        if (s.text.indexOf(findVal) !== -1) {
            s.text = s.text.split(findVal).join(repVal);
            s._modified = true;
            count++;
        }
    });
    syncControlsFromSelected();
    renderEditorList();
    updateEditorStats();
    showStatus('✓ تم الاستبدال في ' + count + ' كابشن', 'success');
    setTimeout(hideStatus, 2200);
}

/* ─── Caption list cards ──────────────────────────────────────── */
function renderEditorList() {
    var list = document.getElementById('editor_caption_list');
    if (!list) return;
    list.innerHTML = '';
    var searchTerm = ((document.getElementById('editor_search') || {}).value || '').toLowerCase();

    for (var i = 0; i < editorSegments.length; i++) {
        var seg = editorSegments[i];
        var text = String(seg.text || '');
        if (searchTerm && text.toLowerCase().indexOf(searchTerm) === -1) continue;

        var card = document.createElement('div');
        card.className = 'caption-card';
        if (i === editorSelectedIndex) card.classList.add('selected');
        if (selectedSet[i]) card.classList.add('multi');
        if (seg._modified) card.classList.add('modified');

        var top = document.createElement('div');
        top.className = 'caption-card-top';

        var num = document.createElement('span');
        num.className = 'caption-card-num';
        num.textContent = (i + 1);
        top.appendChild(num);

        var times = document.createElement('span');
        times.className = 'caption-card-times';
        times.textContent = formatTime(seg.start) + ' ← ' + formatTime(seg.end);
        top.appendChild(times);

        var dur = document.createElement('span');
        dur.className = 'caption-card-dur';
        dur.textContent = formatDuration(seg.end - seg.start);
        top.appendChild(dur);

        var mbadge = document.createElement('span');
        mbadge.className = 'caption-card-modified-badge';
        mbadge.textContent = '• معدل';
        top.appendChild(mbadge);
        card.appendChild(top);

        var body = document.createElement('div');
        body.className = 'caption-card-text';
        body.textContent = text || '(فارغ)';
        if (!text) body.style.color = 'var(--muted)';
        card.appendChild(body);

        var badges = document.createElement('div');
        badges.className = 'caption-card-badges';
        var anim = (seg.meta && seg.meta.animation) || 'none';
        if (anim !== 'none') {
            var a = document.createElement('span');
            a.className = 'badge anim';
            a.textContent = '✨ ' + (ANIMS[anim] ? ANIMS[anim].label : anim);
            badges.appendChild(a);
        }
        if (seg.meta) {
            var st = document.createElement('span');
            st.className = 'badge style';
            st.textContent = '🖌 ' + (seg.meta.fontFamily || 'Segoe UI') + ' ' + (seg.meta.fontSize || 26) + 'px';
            badges.appendChild(st);
        }
        card.appendChild(badges);

        var upbtn = document.createElement('button');
        upbtn.className = 'caption-card-update-btn';
        upbtn.textContent = '🗸 تحديث';
        upbtn.title = 'تحديث هذا الكابشن فقط في التايملاين';
        upbtn.onclick = function(ev) {
            ev.stopPropagation();
            editorSelectCaption(i);
            updateSelectedCaption();
        };
        card.appendChild(upbtn);

        (function(idx) {
            card.addEventListener('click', function(e) {
                if (e.ctrlKey || e.metaKey) toggleMultiSelect(idx);
                else editorSelectCaption(idx);
            });
        })(i);

        list.appendChild(card);
    }

    var scopeSel = document.getElementById('scope_selected');
    if (scopeSel) scopeSel.textContent = 'المحددة (' + Object.keys(selectedSet).length + ')';
}

/* Multi-selection */
function toggleMultiSelect(idx) {
    if (selectedSet[idx]) delete selectedSet[idx];
    else selectedSet[idx] = true;
    renderEditorList();
}
function selectAllCaptions() {
    selectedSet = {};
    for (var i = 0; i < editorSegments.length; i++) selectedSet[i] = true;
    renderEditorList();
}
function clearMultiSelect() {
    selectedSet = {};
    renderEditorList();
}

function editorSelectCaption(idx) {
    if (idx < 0 || idx >= editorSegments.length) return;
    editorSelectedIndex = idx;
    syncControlsFromSelected();
    renderEditorList();
    updatePreviewInstant();
}

/* Sync inspector controls with selected caption */
function syncControlsFromSelected() {
    if (editorSelectedIndex < 0 || !editorSegments.length) return;
    var seg = editorSegments[editorSelectedIndex];
    if (!seg.meta) seg.meta = defaultMeta();

    var setv = function(id, val) { var el = document.getElementById(id); if (el) el.value = val; };
    var setc = function(id, checked) { var el = document.getElementById(id); if (el) el.checked = !!checked; };
    var setl = function(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; };

    var ta = document.getElementById('editor_text_area');
    if (ta) ta.value = seg.text || '';
    var st = document.getElementById('editor_start');
    if (st) st.value = (seg.start !== undefined ? seg.start.toFixed(2) : '0.00');
    var en = document.getElementById('editor_end');
    if (en) en.value = (seg.end !== undefined ? seg.end.toFixed(2) : '0.00');

    var m = seg.meta;
    setv('e_font', m.fontFamily);
    setv('e_size', m.fontSize); setl('e_size_val', m.fontSize + 'px');
    setv('e_weight', m.fontWeight);
    setv('e_color', m.color);
    setv('e_align', m.align);
    setc('e_shadow', m.shadowEnabled);
    setv('e_shadowBlur', m.shadowBlur); setl('e_shadow_val', m.shadowBlur);
    setc('e_stroke', m.strokeEnabled);
    setv('e_strokeWidth', m.strokeWidth); setl('e_stroke_w', m.strokeWidth + 'px');
    setv('e_strokeColor', m.strokeColor);
    setc('e_glow', m.glowEnabled);
    setv('e_glowColor', m.glowColor);
    setc('e_bg', m.bgEnabled);
    setv('e_bgColor', m.bgColor);
    setv('e_bgOp', Math.round((m.bgOpacity || 0.75) * 100)); setl('e_bgOp_val', Math.round((m.bgOpacity || 0.75) * 100) + '%');
    setv('e_bgRad', m.bgRadius); setl('e_bgRad_val', (m.bgRadius || 6) + 'px');
    setv('e_px', m.posX); setl('e_px_val', m.posX + '%');
    setv('e_py', m.posY); setl('e_py_val', m.posY + '%');
    setv('e_scale', m.scale); setl('e_scale_val', m.scale + '%');
    setv('e_rot', m.rotation); setl('e_rot_val', m.rotation + '°');

    document.querySelectorAll('#anim_grid .anim-cell').forEach(function(c) {
        c.classList.toggle('active', c.getAttribute('data-anim') === (m.animation || 'none'));
    });

    updatePreviewInstant();
}

function onMetaChange(key, value) {
    if (editorSelectedIndex < 0) return;
    var seg = editorSegments[editorSelectedIndex];
    if (!seg.meta) seg.meta = defaultMeta();
    seg.meta[key] = value;

    switch (key) {
        case 'fontSize': setText('e_size_val', value + 'px'); break;
        case 'shadowBlur': setText('e_shadow_val', value); break;
        case 'strokeWidth': setText('e_stroke_w', value + 'px'); break;
        case 'bgOpacity': setText('e_bgOp_val', Math.round(value * 100) + '%'); break;
        case 'bgRadius': setText('e_bgRad_val', value + 'px'); break;
        case 'posX': setText('e_px_val', value + '%'); break;
        case 'posY': setText('e_py_val', value + '%'); break;
        case 'scale': setText('e_scale_val', value + '%'); break;
        case 'rotation': setText('e_rot_val', value + '°'); break;
    }
    seg._modified = true;
    updatePreviewInstant();
    renderEditorList();
}
function setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }

/* ═══════════════════════════════════════════════════════════════
   3. LIVE STYLE PREVIEW (Real WYSIWYG Rendering)
   ═══════════════════════════════════════════════════════════════ */

function updatePreviewInstant() {
    var preview = document.getElementById('editor_active_text');
    if (!preview || editorSelectedIndex < 0) return;
    var seg = editorSegments[editorSelectedIndex];
    if (!seg.meta) seg.meta = defaultMeta();
    var m = seg.meta;

    preview.textContent = seg.text || 'اكتب نص الكابشن هنا...';
    preview.style.fontFamily = m.fontFamily || 'Segoe UI';
    preview.style.fontSize = (m.fontSize || 26) + 'px';
    preview.style.fontWeight = m.fontWeight || 600;
    preview.style.color = m.color || '#ffffff';
    preview.style.textAlign = m.align || 'center';

    // Stroke
    if (m.strokeEnabled && m.strokeWidth > 0) {
        preview.style.webkitTextStroke = m.strokeWidth + 'px ' + (m.strokeColor || '#000000');
        preview.style.paintOrder = 'stroke fill';
    } else {
        preview.style.webkitTextStroke = '';
        preview.style.paintOrder = 'normal';
    }

    // Background box
    if (m.bgEnabled) {
        preview.style.backgroundColor = hexToRgba(m.bgColor || '#000000', m.bgOpacity !== undefined ? m.bgOpacity : 0.75);
        preview.style.borderRadius = (m.bgRadius || 6) + 'px';
        preview.style.padding = '8px 16px';
    } else {
        preview.style.backgroundColor = 'transparent';
        preview.style.borderRadius = '0';
        preview.style.padding = '6px 12px';
    }

    // Shadow / Glow
    if (m.glowEnabled) {
        preview.style.textShadow = '0 0 10px ' + (m.glowColor || '#2680EB') + ', 0 0 24px ' + (m.glowColor || '#2680EB');
    } else if (m.shadowEnabled) {
        preview.style.textShadow = '0 ' + Math.round((m.shadowBlur || 8) / 2) + 'px ' + (m.shadowBlur || 8) + 'px rgba(0,0,0,0.85)';
    } else {
        preview.style.textShadow = 'none';
    }

    // Position & Transform
    var scale = (m.scale || 100) / 100;
    preview.style.position = 'absolute';
    preview.style.left = (m.posX !== undefined ? m.posX : 50) + '%';
    preview.style.top = (m.posY !== undefined ? m.posY : 90) + '%';
    preview.style.transform = 'translate(-50%, -50%) scale(' + scale + ') rotate(' + (m.rotation || 0) + 'deg)';
    preview.style.maxWidth = '92%';
}

/* ═══════════════════════════════════════════════════════════════
   4. ANIMATION PRESETS
   ═══════════════════════════════════════════════════════════════ */

function setAnimation(name) {
    if (editorSelectedIndex < 0) return;
    var targets = Object.keys(selectedSet).length > 0 ? Object.keys(selectedSet).map(Number) : [editorSelectedIndex];
    targets.forEach(function(i) {
        if (!editorSegments[i].meta) editorSegments[i].meta = defaultMeta();
        editorSegments[i].meta.animation = name;
        editorSegments[i]._modified = true;
    });
    renderEditorList();
    triggerPreviewAnimation(name);
}

function triggerPreviewAnimation(name) {
    var preview = document.getElementById('editor_active_text');
    if (!preview) return;
    var key = ANIMS[name] ? ANIMS[name].key : '';
    preview.style.animation = 'none';
    preview.offsetHeight; // reflow to restart
    if (key) {
        preview.style.animationName = key;
        preview.style.animationDuration = '0.7s';
        preview.style.animationTimingFunction = 'ease';
        preview.style.animationIterationCount = (name === 'glow' || name === 'highlight') ? 'infinite' : '1';
    }
}

function applyStyleScope(scope) {
    if (editorSelectedIndex < 0) return;
    var meta = editorSegments[editorSelectedIndex].meta;
    var targets = [];
    if (scope === 'current') targets = [editorSelectedIndex];
    else if (scope === 'selected') {
        targets = Object.keys(selectedSet).map(Number);
        if (targets.length === 0) targets = [editorSelectedIndex];
    } else if (scope === 'all') {
        for (var i = 0; i < editorSegments.length; i++) targets.push(i);
    }

    targets.forEach(function(i) {
        if (!editorSegments[i].meta) editorSegments[i].meta = defaultMeta();
        editorSegments[i].meta = JSON.parse(JSON.stringify(meta));
        editorSegments[i]._modified = true;
    });
    renderEditorList();
    updatePreviewInstant();
    showStatus('✓ تم تطبيق النمط على ' + targets.length + ' كابشن', 'success');
    setTimeout(hideStatus, 2000);
}

function hexToRgba(hex, alpha) {
    hex = (hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function(c) { return c + c; }).join('');
    var r = parseInt(hex.substring(0, 2), 16) || 0;
    var g = parseInt(hex.substring(2, 4), 16) || 0;
    var b = parseInt(hex.substring(4, 6), 16) || 0;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha !== undefined ? alpha : 1) + ')';
}

function updateEditorStats() {
    var totalWords = 0;
    var totalChars = 0;
    var totalDur = 0;
    editorSegments.forEach(function(s) {
        totalWords += String(s.text || '').split(/\s+/).filter(Boolean).length;
        totalChars += String(s.text || '').length;
        totalDur = Math.max(totalDur, s.end || 0);
    });
    var statsEl = document.getElementById('editor_stats');
    if (statsEl) statsEl.textContent = editorSegments.length + ' كابشن · ' + totalWords + ' كلمة · ' + formatDuration(totalDur);

    var wEl = document.getElementById('stat_words'); if (wEl) wEl.textContent = totalWords;
    var lEl = document.getElementById('stat_lines'); if (lEl) lEl.textContent = editorSegments.length;
    var dEl = document.getElementById('stat_duration'); if (dEl) dEl.textContent = formatDuration(totalDur);
    var cEl = document.getElementById('stat_clips'); if (cEl) cEl.textContent = editorSegments.length;
}

/* ─── Caption CRUD ops ────────────────────────────────────────── */
function editorAddCaption() {
    var lastEnd = editorSegments.length > 0 ? editorSegments[editorSegments.length - 1].end : 0;
    var seg = { start: lastEnd, end: lastEnd + 2, text: '', words: [], meta: defaultMeta(), _modified: true };
    editorSegments.push(seg);
    editorSelectedIndex = editorSegments.length - 1;
    renderEditorList();
    syncControlsFromSelected();
    updateEditorStats();
}
function editorDuplicateCaption() {
    if (editorSelectedIndex < 0) return;
    var src = editorSegments[editorSelectedIndex];
    var copy = JSON.parse(JSON.stringify(src));
    var dur = (src.end || 0) - (src.start || 0);
    copy.start = src.end || src.start;
    copy.end = copy.start + dur;
    copy._modified = true;
    editorSegments.splice(editorSelectedIndex + 1, 0, copy);
    editorSelectedIndex = editorSelectedIndex + 1;
    renderEditorList();
    syncControlsFromSelected();
    updateEditorStats();
}
function editorDeleteCaption() {
    if (editorSelectedIndex < 0) return;
    editorSegments.splice(editorSelectedIndex, 1);
    if (editorSegments.length === 0) { editorSelectedIndex = -1; buildEditorPanelHTML(); }
    else if (editorSelectedIndex >= editorSegments.length) editorSelectedIndex = editorSegments.length - 1;
    renderEditorList();
    syncControlsFromSelected();
    updateEditorStats();
}
function editorMergeCaption() {
    if (editorSelectedIndex < 0 || editorSelectedIndex >= editorSegments.length - 1) return;
    var a = editorSegments[editorSelectedIndex];
    var b = editorSegments[editorSelectedIndex + 1];
    a.text = (a.text ? a.text : '') + ' ' + (b.text ? b.text : '');
    a.end = b.end;
    a._modified = true;
    editorSegments.splice(editorSelectedIndex + 1, 1);
    renderEditorList();
    syncControlsFromSelected();
    updateEditorStats();
}
function editorSplitCaption() {
    if (editorSelectedIndex < 0) return;
    var seg = editorSegments[editorSelectedIndex];
    var words = String(seg.text || '').split(/\s+/).filter(Boolean);
    if (words.length < 2) { showStatus('لا يمكن تقسيم كابشن بكلمة واحدة.', 'info'); return; }
    var mid = Math.ceil(words.length / 2);
    var first = words.slice(0, mid).join(' ');
    var second = words.slice(mid).join(' ');
    var midTime = seg.start + (seg.end - seg.start) / 2;
    var a = seg;
    var b = JSON.parse(JSON.stringify(seg));
    a.text = first; a.end = midTime; a._modified = true;
    b.text = second; b.start = midTime; b._modified = true;
    editorSegments.splice(editorSelectedIndex + 1, 0, b);
    editorSelectedIndex = editorSelectedIndex + 1;
    renderEditorList();
    syncControlsFromSelected();
    updateEditorStats();
}

function filterCaptions() { renderEditorList(); }

/* ─── Styles page standalone preview ──────────────────────────── */
function applyFont() {
    var preview = document.getElementById('styles_preview_text');
    if (!preview) return;
    var ff = document.getElementById('font_family');
    var fsEl = document.getElementById('font_size');
    var fw = document.getElementById('font_weight');
    if (ff) preview.style.fontFamily = ff.value;
    if (fsEl) { preview.style.fontSize = fsEl.value + 'px'; var v = document.getElementById('font_size_value'); if (v) v.textContent = fsEl.value + 'px'; }
    if (fw) preview.style.fontWeight = fw.value;
}
function applyColor() {
    var preview = document.getElementById('styles_preview_text');
    var tc = document.getElementById('text_color');
    if (preview && tc) preview.style.color = tc.value;
}

function buildAnimationsPage() {
    var grid = document.getElementById('anims_grid');
    if (!grid) return;
    grid.innerHTML = '';
    var icons = { none:'—', fade:'👻', pop:'💥', bounce:'🎈', scale:'🔍', slide:'➡️', zoom:'🔎', glow:'🌟', typewriter:'⌨️', highlight:'🖍️' };
    Object.keys(ANIMS).forEach(function(k) {
        var cell = document.createElement('div');
        cell.className = 'anim-cell' + (k === 'fade' ? ' active' : '');
        cell.innerHTML = '<span class="anim-icon">' + (icons[k] || '✨') + '</span>' + ANIMS[k].label;
        cell.onclick = function() {
            document.querySelectorAll('#anims_grid .anim-cell').forEach(function(c) { c.classList.remove('active'); });
            cell.classList.add('active');
            var prev = document.getElementById('anims_preview_text');
            if (prev) {
                var key = ANIMS[k].key;
                prev.style.animation = 'none';
                prev.offsetHeight;
                if (key) {
                    prev.style.animationName = key;
                    prev.style.animationDuration = '0.7s';
                }
            }
        };
        grid.appendChild(cell);
    });
}

/* ─── Navigation ──────────────────────────────────────────────── */
function navigateTo(pageId) {
    document.querySelectorAll('.page-section').forEach(function(p) { p.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    var target = document.getElementById('page_' + pageId);
    if (target) target.classList.add('active');
    var navItem = document.querySelector('.nav-item[data-page="' + pageId + '"]');
    if (navItem) navItem.classList.add('active');
    if (pageId === 'dashboard') { updateDashboardInfo(); updateActiveSequence(); }
}

function setTheme(themeName) {
    document.body.className = themeName;
    document.querySelectorAll('.theme-card').forEach(function(c) { c.classList.remove('active'); });
    var activeCard = document.querySelector('.theme-card[onclick*="' + themeName + '"]');
    if (activeCard) activeCard.classList.add('active');
}
