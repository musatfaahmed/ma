/*************************************************************************
 * MOSTAFA STYLE CAPTION - ExtendScript for Adobe Premiere Pro
 * 
 * Offline Speech-to-Text caption generation & timeline integration.
 * Real speech-to-text with Whisper.cpp and FFmpeg.
 **************************************************************************/

if (typeof($) == 'undefined') {
    $ = {};
}

$._MSC_ = {

    /**
     * Updates the Events panel in Premiere Pro with a message.
     */
    updateEventPanel: function(message) {
        try {
            app.setSDKEventMessage(message, 'info');
        } catch (e) {}
    },

    /**
     * Returns the active sequence name.
     */
    getActiveSequenceName: function() {
        try {
            var activeSeq = app.project.activeSequence;
            if (activeSeq && activeSeq.name) {
                return activeSeq.name;
            }
            return 'لا يوجد سيكونس نشط';
        } catch (e) {
            return 'لا يوجد سيكونس نشط';
        }
    },

    /**
     * Returns project and sequence information as JSON.
     */
    getProjectInfo: function() {
        var info = {
            projectName: '',
            sequenceName: '',
            duration: 0,
            hasActiveSequence: false
        };
        try {
            if (app.project) {
                info.projectName = app.project.name || '';
                var seq = app.project.activeSequence;
                if (seq) {
                    info.hasActiveSequence = true;
                    info.sequenceName = seq.name || '';
                    info.duration = $._MSC_.ticksToSeconds(seq.end);
                }
            }
        } catch (e) {}
        return JSON.stringify(info);
    },

    /**
     * Keeps the panel loaded and persistent across workspaces.
     */
    keepPanelLoaded: function() {
        try {
            app.setExtensionPersistent('com.mostafa.stylecaption.panel', 0);
        } catch (e) {}
    },

    /**
     * Gets path separator for current OS.
     */
    getSep: function() {
        return (Folder.fs === 'Windows') ? '\\' : '/';
    },

    /**
     * Gets temp folder path.
     */
    getTempFolder: function() {
        return Folder.temp.fsName;
    },

    /**
     * Extracts audio/media path from the active sequence.
     * Returns the first media file that contains audio.
     */
    getSequenceMediaPath: function() {
        var result = {
            success: false,
            mediaPath: '',
            message: ''
        };

        try {
            var activeSeq = app.project.activeSequence;
            
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط. يرجى فتح سيكونس في التايملاين أولاً.';
                return JSON.stringify(result);
            }

            // 1. Search audio tracks first
            var audioTracks = activeSeq.audioTracks;
            if (audioTracks && audioTracks.numTracks > 0) {
                for (var t = 0; t < audioTracks.numTracks; t++) {
                    var track = audioTracks[t];
                    if (track.clips && track.clips.numItems > 0) {
                        for (var c = 0; c < track.clips.numItems; c++) {
                            var clip = track.clips[c];
                            if (clip.projectItem) {
                                var mediaPath = clip.projectItem.getMediaPath();
                                if (mediaPath && mediaPath.length > 0) {
                                    var mediaFile = new File(mediaPath);
                                    if (mediaFile.exists) {
                                        result.success = true;
                                        result.mediaPath = mediaPath;
                                        result.message = 'تم العثور على وسائط صوتية: ' + mediaPath;
                                        $._MSC_.updateEventPanel('استخدام الصوت من: ' + clip.projectItem.name);
                                        return JSON.stringify(result);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 2. Search video tracks (video files contain audio)
            var videoTracks = activeSeq.videoTracks;
            if (videoTracks && videoTracks.numTracks > 0) {
                for (var vt = 0; vt < videoTracks.numTracks; vt++) {
                    var vTrack = videoTracks[vt];
                    if (vTrack.clips && vTrack.clips.numItems > 0) {
                        for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                            var vClip = vTrack.clips[vc];
                            if (vClip.projectItem) {
                                var vMediaPath = vClip.projectItem.getMediaPath();
                                if (vMediaPath && vMediaPath.length > 0) {
                                    var vMediaFile = new File(vMediaPath);
                                    if (vMediaFile.exists) {
                                        result.success = true;
                                        result.mediaPath = vMediaPath;
                                        result.message = 'تم العثور على وسائط فيديو (مع صوت): ' + vMediaPath;
                                        $._MSC_.updateEventPanel('استخدام الوسائط من: ' + vClip.projectItem.name);
                                        return JSON.stringify(result);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            result.message = 'لم يتم العثور على ملفات وسائط في السيكونس. تأكد من إضافة مقاطع صوت أو فيديو إلى التايملاين.';

        } catch (e) {
            result.message = 'خطأ في استخراج مسار الوسائط: ' + e.message;
        }

        return JSON.stringify(result);
    },

    /**
     * Gets sequence timing information.
     */
    getSequenceInfo: function() {
        var result = {
            success: false,
            inPoint: 0,
            outPoint: 0,
            duration: 0,
            frameRate: 24
        };

        try {
            var activeSeq = app.project.activeSequence;
            if (activeSeq) {
                result.success = true;
                result.inPoint = activeSeq.getInPoint();
                result.outPoint = activeSeq.getOutPoint();
                result.duration = $._MSC_.ticksToSeconds(activeSeq.end);
                
                var settings = activeSeq.getSettings();
                if (settings && settings.videoFrameRate) {
                    result.frameRate = settings.videoFrameRate.seconds ? (1 / settings.videoFrameRate.seconds) : 24;
                }
            }
        } catch (e) {
            result.message = e.message;
        }

        return JSON.stringify(result);
    },

    /**
     * Finds or creates a bin in the project.
     */
    findOrCreateBin: function(binName) {
        var root = app.project.rootItem;
        for (var i = 0; i < root.children.numItems; i++) {
            var item = root.children[i];
            if (item.type === ProjectItemType.BIN && item.name === binName) {
                return item;
            }
        }
        return root.createBin(binName);
    },

    /**
     * Writes caption data (segments) into an SRT file on disk with UTF-8 BOM.
     */
    writeSRTFile: function(srtPath, jsonSegments) {
        var result = { success: false, message: '' };
        try {
            var segments = JSON.parse(jsonSegments);
            var srt = '\uFEFF'; // UTF-8 BOM for full Arabic character support
            for (var i = 0; i < segments.length; i++) {
                var seg = segments[i];
                srt += (i + 1) + '\n';
                srt += $._MSC_.formatSRTTime(seg.start) + ' --> ' + $._MSC_.formatSRTTime(seg.end) + '\n';
                srt += (seg.text || '') + '\n\n';
            }
            var f = new File(srtPath);
            f.encoding = 'UTF-8';
            if (f.open('w')) {
                f.write(srt);
                f.close();
                result.success = true;
                result.message = 'تم حفظ ملف SRT بنجاح';
            } else {
                result.message = 'تعذر فتح ملف SRT للكتابة: ' + srtPath;
            }
        } catch (e) {
            result.message = 'خطأ في كتابة SRT: ' + e.message;
        }
        return JSON.stringify(result);
    },

    /**
     * Formats seconds as SRT timecode HH:MM:SS,mmm
     */
    formatSRTTime: function(sec) {
        sec = Number(sec) || 0;
        if (sec < 0) sec = 0;
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = Math.floor(sec % 60);
        var ms = Math.floor((sec % 1) * 1000);
        function pad(n, len) {
            var str = String(n);
            while (str.length < len) str = '0' + str;
            return str;
        }
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
    },

    /**
     * PRIMARY IMPORT: Imports an SRT file into Premiere Pro, places it into
     * a dedicated bin, adds it to the active sequence timeline, and places
     * synchronized caption markers with animation metadata.
     */
    importSRTAndCreateCaptions: function(srtPath) {
        var result = {
            success: false,
            captionCount: 0,
            placedOnTimeline: false,
            message: ''
        };

        try {
            var activeSeq = app.project.activeSequence;
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط في Premiere. يرجى فتح سيكونس أولاً.';
                return JSON.stringify(result);
            }

            var srtFile = new File(srtPath);
            if (!srtFile.exists) {
                result.message = 'ملف SRT غير موجود: ' + srtPath;
                return JSON.stringify(result);
            }

            $._MSC_.updateEventPanel('جاري استيراد ملف الكابشن: ' + srtFile.name);

            // 1. Create or find caption bin
            var targetBin = $._MSC_.findOrCreateBin('Mostafa Captions');

            // 2. Import the SRT file into the project bin
            var importSuccess = false;
            try {
                importSuccess = app.project.importFiles(
                    [srtPath],
                    true,       // suppress UI dialogs
                    targetBin,  // target bin
                    false       // not image sequence
                );
            } catch (impErr) {
                // Ignore non-fatal import error
            }

            // 3. Locate the imported SRT ProjectItem
            var srtProjectItem = null;
            var searchBins = [targetBin, app.project.rootItem];
            for (var b = 0; b < searchBins.length && !srtProjectItem; b++) {
                var bin = searchBins[b];
                if (bin && bin.children) {
                    for (var i = bin.children.numItems - 1; i >= 0; i--) {
                        var item = bin.children[i];
                        if (item && item.name && item.name.toLowerCase().indexOf('.srt') !== -1) {
                            srtProjectItem = item;
                            break;
                        }
                    }
                }
            }

            // 4. Place onto sequence timeline:
            // Attempt Premiere Pro native caption track creation (Premiere Pro 15.0+)
            var timelinePlaced = false;
            if (srtProjectItem) {
                // A) Try Premiere Pro native createCaptionTrack API if supported
                try {
                    if (typeof activeSeq.createCaptionTrack === 'function') {
                        activeSeq.createCaptionTrack(srtProjectItem, 0);
                        timelinePlaced = true;
                    }
                } catch (ctErr) {}

                // B) If native caption track wasn't created, insert/overwrite onto video tracks
                if (!timelinePlaced && activeSeq.videoTracks && activeSeq.videoTracks.numTracks > 0) {
                    try {
                        var targetTrackIndex = activeSeq.videoTracks.numTracks - 1;
                        var vTrack = activeSeq.videoTracks[targetTrackIndex];
                        if (vTrack) {
                            vTrack.overwriteClip(srtProjectItem, '0');
                            timelinePlaced = true;
                        }
                    } catch (otErr) {
                        try {
                            activeSeq.videoTracks[0].insertClip(srtProjectItem, '0');
                            timelinePlaced = true;
                        } catch (itErr) {}
                    }
                }
            }

            // 5. Parse SRT and generate synchronized markers with animation tags
            var segments = $._MSC_.parseSRTFile(srtPath);
            var markerCount = 0;
            if (segments && segments.length > 0) {
                var mkResult = JSON.parse($._MSC_.createCaptionMarkers(JSON.stringify(segments)));
                markerCount = mkResult.count || segments.length;
            }

            result.success = true;
            result.captionCount = markerCount || (segments ? segments.length : 0);
            result.placedOnTimeline = timelinePlaced;
            result.message = 'تم استيراد ' + result.captionCount + ' كابشن بنجاح إلى التايملاين';
            $._MSC_.updateEventPanel('MostafaStyleCaption: تم استيراد ' + result.captionCount + ' كابشن');

        } catch (e) {
            result.message = 'خطأ في استيراد الكابشن إلى Premiere: ' + e.message;
        }

        return JSON.stringify(result);
    },

    /**
     * Places Premiere timeline markers representing caption cues.
     * Each marker carries the caption text / timing and animation tag.
     */
    createCaptionMarkers: function(jsonSegments) {
        var result = { success: false, count: 0, message: '' };
        try {
            var activeSeq = app.project.activeSequence;
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط.';
                return JSON.stringify(result);
            }

            var segments = JSON.parse(jsonSegments);
            var created = 0;

            for (var i = 0; i < segments.length; i++) {
                var seg = segments[i];
                var startTicks = $._MSC_.secondsToTicks(seg.start || 0);
                var markerComment = seg.text || '';
                try {
                    var marker = activeSeq.createMarker(startTicks);
                    if (marker) {
                        marker.name = 'MSC[' + i + ']';
                        marker.comments = markerComment;
                        marker.duration = $._MSC_.secondsToTicks((seg.end || seg.start) - (seg.start || 0));
                        // Store animation metadata
                        if (seg.animation && seg.animation !== 'none') {
                            marker.markersExtendScriptStore = '_msc_anim_' + seg.animation;
                        }
                        created++;
                    }
                } catch (me) {}
            }

            result.success = true;
            result.count = created;
            result.message = 'تم إنشاء ' + created + ' علامة كابشن على التايملاين';
        } catch (e) {
            result.message = 'خطأ في إنشاء العلامات: ' + e.message;
        }
        return JSON.stringify(result);
    },

    /**
     * Removes only the markers created by this extension (prefixed MSC_)
     * WITHOUT touching user content, other markers, or existing sequence tracks.
     */
    removeOwnCaptionMarkers: function() {
        var result = { success: false, removed: 0, message: '' };
        try {
            var activeSeq = app.project.activeSequence;
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط.';
                return JSON.stringify(result);
            }
            var markers = activeSeq.markers;
            var removed = 0;
            if (markers) {
                for (var i = markers.numMarkers - 1; i >= 0; i--) {
                    var marker = markers[i];
                    if (marker && marker.name && marker.name.indexOf('MSC[') === 0) {
                        try {
                            marker.deleteMarker();
                            removed++;
                        } catch (e) {}
                    }
                }
            }
            result.success = true;
            result.removed = removed;
            result.message = 'تم مسح ' + removed + ' علامة قديمة';
        } catch (e) {
            result.message = 'خطأ: ' + e.message;
        }
        return JSON.stringify(result);
    },

    /**
     * Updates ONLY a single caption marker (by index) preserving its position
     * and duration. Used by the "تحديث الكابشن المحدد" button.
     */
    updateSingleCaptionMarker: function(index, jsonSegment) {
        var result = { success: false, message: '' };
        try {
            var activeSeq = app.project.activeSequence;
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط.';
                return JSON.stringify(result);
            }
            var seg = JSON.parse(jsonSegment);
            var markers = activeSeq.markers;
            var targetMarker = null;
            var targetKey = 'MSC[' + index + ']';

            if (markers) {
                for (var i = 0; i < markers.numMarkers; i++) {
                    var marker = markers[i];
                    if (marker && marker.name === targetKey) {
                        targetMarker = marker;
                        break;
                    }
                }
            }

            if (!targetMarker) {
                try {
                    var mk = activeSeq.createMarker($._MSC_.secondsToTicks(seg.start || 0));
                    mk.name = targetKey;
                    mk.comments = seg.text || '';
                    targetMarker = mk;
                } catch (e) {}
            }

            if (targetMarker) {
                targetMarker.comments = seg.text || '';
                targetMarker.duration = $._MSC_.secondsToTicks((seg.end || seg.start) - (seg.start || 0));
                if (seg.animation && seg.animation !== 'none') {
                    targetMarker.markersExtendScriptStore = '_msc_anim_' + seg.animation;
                }
                result.success = true;
                result.message = 'تم تحديث الكابشن رقم ' + (Number(index) + 1) + ' في التايملاين بنجاح';
                $._MSC_.updateEventPanel('MostafaStyleCaption: تم تحديث الكابشن #' + (Number(index) + 1));
            } else {
                result.message = 'تعذر العثور على الكابشن في التايملاين.';
            }
        } catch (e) {
            result.message = 'خطأ في تحديث الكابشن: ' + e.message;
        }
        return JSON.stringify(result);
    },

    /**
     * Converts seconds to Premiere time ticks (254016000000 ticks/sec).
     */
    secondsToTicks: function(seconds) {
        return Math.round((Number(seconds) || 0) * 254016000000);
    },

    /**
     * Converts ticks to seconds.
     */
    ticksToSeconds: function(ticks) {
        return (Number(ticks) || 0) / 254016000000;
    },

    /**
     * Parses an SRT file into segment objects with start, end, text.
     */
    parseSRTFile: function(srtPath) {
        var segments = [];
        try {
            var f = new File(srtPath);
            if (!f.exists) return segments;
            f.encoding = 'UTF-8';
            if (!f.open('r')) return segments;

            var raw = f.read();
            f.close();

            raw = raw.replace(/^\uFEFF/, '');
            var text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            var blocks = text.split('\n\n');

            for (var i = 0; i < blocks.length; i++) {
                var block = blocks[i].split('\n');
                if (block.length < 2) continue;
                var timeLine = block[1];
                var timeMatch = timeLine.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/);
                if (!timeMatch) continue;
                var start = $._MSC_.srtPartsToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
                var end = $._MSC_.srtPartsToSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
                var textLines = block.slice(2).join(' ').trim();
                if (!textLines) continue;
                segments.push({ start: start, end: end, text: textLines, words: [], confidence: 1.0 });
            }
        } catch (e) {}
        return segments;
    },

    /**
     * Converts SRT time parts to seconds.
     */
    srtPartsToSeconds: function(h, m, s, ms) {
        return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
    }
};
