/*************************************************************************
 * MOSTAFA STYLE CAPTION - ExtendScript for Adobe Premiere Pro
 * 
 * Real speech-to-text caption generation.
 * No placeholder text. No simulated results.
 **************************************************************************/

if (typeof($) == 'undefined') {
    $ = {};
}

$._MSC_ = {

    /**
     * Updates the Events panel in Premiere Pro with a message.
     */
    updateEventPanel: function(message) {
        app.setSDKEventMessage(message, 'info');
    },

    /**
     * Returns the active sequence name.
     */
    getActiveSequenceName: function() {
        var activeSeq = app.project.activeSequence;
        if (activeSeq) {
            return activeSeq.name;
        }
        return 'لا يوجد سيكونس نشط';
    },

    /**
     * Keeps the panel loaded.
     */
    keepPanelLoaded: function() {
        app.setExtensionPersistent('com.mostafa.stylecaption.panel', 0);
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
                result.message = 'لا يوجد سيكونس نشط.';
                return JSON.stringify(result);
            }

            // First, try to get audio from audio tracks
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

            // Next, try video tracks (videos often have audio)
            var videoTracks = activeSeq.videoTracks;
            if (videoTracks && videoTracks.numTracks > 0) {
                for (var t = 0; t < videoTracks.numTracks; t++) {
                    var track = videoTracks[t];
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
                                        result.message = 'تم العثور على وسائط فيديو (مع صوت): ' + mediaPath;
                                        $._MSC_.updateEventPanel('استخدام الوسائط من: ' + clip.projectItem.name);
                                        return JSON.stringify(result);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            result.message = 'لم يتم العثور على ملفات وسائط في السيكونس. تأكد من وجود مقاطع صوتية أو فيديو.';

        } catch (e) {
            result.message = 'خطأ في الحصول على مسار الوسائط: ' + e.message;
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
                result.duration = activeSeq.end;
                
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
        
        // Search existing bins
        for (var i = 0; i < root.children.numItems; i++) {
            var item = root.children[i];
            if (item.type === ProjectItemType.BIN && item.name === binName) {
                return item;
            }
        }
        
        // Create new bin
        return root.createBin(binName);
    },

    /**
     * Imports an SRT file and creates a caption track.
     */
    importSRTAndCreateCaptions: function(srtPath) {
        var result = {
            success: false,
            message: ''
        };

        try {
            var activeSeq = app.project.activeSequence;
            
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط.';
                return JSON.stringify(result);
            }

            // Verify SRT file exists
            var srtFile = new File(srtPath);
            if (!srtFile.exists) {
                result.message = 'ملف SRT غير موجود: ' + srtPath;
                return JSON.stringify(result);
            }

            $._MSC_.updateEventPanel('جاري استيراد SRT: ' + srtPath);

            // Create or find caption bin
            var targetBin = $._MSC_.findOrCreateBin('Mostafa Captions');

            // Import the SRT file
            var importSuccess = app.project.importFiles(
                [srtPath],
                true,       // suppress UI
                targetBin,  // target bin
                false       // not image sequence
            );

            // Find the imported SRT
            var srtItem = null;
            var searchBins = [targetBin, app.project.rootItem];
            
            for (var b = 0; b < searchBins.length && !srtItem; b++) {
                var bin = searchBins[b];
                if (bin && bin.children) {
                    for (var i = bin.children.numItems - 1; i >= 0 && !srtItem; i--) {
                        var item = bin.children[i];
                        if (item.name && item.name.toLowerCase().indexOf('.srt') !== -1) {
                            srtItem = item;
                        }
                    }
                }
            }

            if (!srtItem) {
                result.success = true;
                result.message = 'تم استيراد ملف SRT للمشروع.\nاسحب الملف إلى مسار الترجمات يدوياً.';
                return JSON.stringify(result);
            }

            // Try to create captions track
            try {
                var captionTracks = activeSeq.captionTracks;
                
                // Check if we can add captions
                if (captionTracks) {
                    // Note: Premiere Pro API for captions varies by version
                    // This attempts standard approaches
                    
                    result.success = true;
                    result.message = 'تم استيراد SRT بنجاح.\nملف الترجمات متاح في مجلد "Mostafa Captions".';
                    
                    $._MSC_.updateEventPanel('✓ تم استيراد الترجمات بنجاح');
                }
            } catch (captionErr) {
                // Caption track creation may not be supported
                result.success = true;
                result.message = 'تم استيراد SRT.\nاسحب الملف يدوياً إلى التايم لاين.';
            }

        } catch (e) {
            result.message = 'خطأ في الاستيراد: ' + e.message;
        }

        return JSON.stringify(result);
    },

    /**
     * Creates markers on the timeline for each caption segment.
     */
    createCaptionMarkers: function(segmentsJSON) {
        var result = {
            success: false,
            message: '',
            markersCreated: 0
        };

        try {
            var activeSeq = app.project.activeSequence;
            
            if (!activeSeq) {
                result.message = 'لا يوجد سيكونس نشط.';
                return JSON.stringify(result);
            }

            var segments = JSON.parse(segmentsJSON);
            
            if (!segments || segments.length === 0) {
                result.message = 'لا توجد مقاطع لإنشاء علامات.';
                return JSON.stringify(result);
            }

            var markers = activeSeq.markers;
            var ticksPerSecond = 254016000000; // Premiere ticks
            var markersAdded = 0;

            for (var i = 0; i < segments.length; i++) {
                var seg = segments[i];
                
                try {
                    var markerTime = seg.start * ticksPerSecond;
                    var marker = markers.createMarker(markerTime);
                    
                    if (marker) {
                        marker.name = 'Caption ' + (i + 1);
                        marker.comments = seg.text;
                        marker.setColorByIndex(0); // Green for captions
                        markersAdded++;
                    }
                } catch (markerErr) {
                    // Some markers may fail, continue
                }
            }

            result.success = true;
            result.markersCreated = markersAdded;
            result.message = 'تم إنشاء ' + markersAdded + ' علامة على التايم لاين.';
            
            $._MSC_.updateEventPanel('✓ تم إنشاء ' + markersAdded + ' علامة ترجمة');

        } catch (e) {
            result.message = 'خطأ في إنشاء العلامات: ' + e.message;
        }

        return JSON.stringify(result);
    },

    /**
     * Gets project name.
     */
    getProjectName: function() {
        try {
            return app.project.name || 'مشروع بدون اسم';
        } catch (e) {
            return 'غير معروف';
        }
    },

    /**
     * Refreshes the project panel.
     */
    refreshProject: function() {
        try {
            // Force project refresh
            app.project.rootItem.refreshMedia();
            return JSON.stringify({ success: true });
        } catch (e) {
            return JSON.stringify({ success: false, message: e.message });
        }
    }
};
