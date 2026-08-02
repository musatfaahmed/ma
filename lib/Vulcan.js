/**************************************************************************************************
 *
 * ADOBE SYSTEMS INCORPORATED
 * Copyright 2013 Adobe Systems Incorporated
 * All Rights Reserved.
 *
 * NOTICE:  Adobe permits you to use, modify, and distribute this file in accordance with the
 * terms of the Adobe license agreement accompanying it.
 *
 **************************************************************************************************/

/** Vulcan - v11.0.0 (inter-application messaging) */

/**
 * @class Vulcan
 * The singleton instance, VulcanInterface, provides an interface
 * to the Vulcan Control Server for inter-application messaging.
 */
function Vulcan() {}

/**
 * Checks whether a Creative Suite application is running.
 * @param specifier The application specifier, e.g. "premierepro-13.0".
 */
Vulcan.prototype.isAppRunning = function(specifier) {
    if (!specifier) return false;
    var params = {};
    params.type = VulcanMessage.TYPE_PREFIX + "AppRunning";
    params.appSpecifier = specifier;
    try {
        var ret = window.__adobe_cep__.invokeSync("vulcanIsAppRunning", JSON.stringify(params));
        return ret === "true" || ret === true;
    } catch (e) {
        return false;
    }
};

/**
 * Checks whether a Creative Suite application is installed.
 */
Vulcan.prototype.isAppInstalled = function(specifier) {
    if (!specifier) return false;
    var params = {};
    params.appSpecifier = specifier;
    try {
        var ret = window.__adobe_cep__.invokeSync("vulcanIsAppInstalled", JSON.stringify(params));
        return ret === "true" || ret === true;
    } catch (e) {
        return false;
    }
};

/**
 * Retrieves the local install path of a Creative Suite application.
 */
Vulcan.prototype.getAppPath = function(specifier) {
    if (!specifier) return "";
    var params = {};
    params.appSpecifier = specifier;
    try {
        return window.__adobe_cep__.invokeSync("vulcanGetAppPath", JSON.stringify(params));
    } catch (e) {
        return "";
    }
};

/**
 * Launches a Creative Suite application.
 */
Vulcan.prototype.launchApp = function(specifier, focus, cmdLine) {
    if (!specifier) return false;
    var params = {};
    params.appSpecifier = specifier;
    params.focus = focus ? "true" : "false";
    params.cmdLine = cmdLine || "";
    try {
        var ret = window.__adobe_cep__.invokeSync("vulcanLaunchApp", JSON.stringify(params));
        return ret === "true" || ret === true;
    } catch (e) {
        return false;
    }
};

/**
 * Registers a message listener callback function for a Vulcan message.
 */
Vulcan.prototype.addMessageListener = function(type, callback, obj) {
    if (!type || !callback) return;
    var params = {};
    params.type = type;
    try {
        window.__adobe_cep__.invokeAsync("vulcanAddMessageListener", JSON.stringify(params), callback, obj);
    } catch (e) {}
};

/**
 * Removes a registered message listener callback function for a Vulcan message.
 */
Vulcan.prototype.removeMessageListener = function(type, callback, obj) {
    if (!type || !callback) return;
    var params = {};
    params.type = type;
    try {
        window.__adobe_cep__.invokeAsync("vulcanRemoveMessageListener", JSON.stringify(params), callback, obj);
    } catch (e) {}
};

/**
 * Dispatches a Vulcan message.
 */
Vulcan.prototype.dispatchMessage = function(vulcanMessage) {
    if (!vulcanMessage) return;
    try {
        var message = new VulcanMessage(vulcanMessage.type);
        message.initialize(vulcanMessage);
        window.__adobe_cep__.invokeSync("vulcanDispatchMessage", JSON.stringify(message));
    } catch (e) {}
};

/**
 * Retrieves the message payload of a Vulcan message.
 */
Vulcan.prototype.getPayload = function(vulcanMessage) {
    if (!vulcanMessage) return null;
    var message = new VulcanMessage(vulcanMessage.type);
    message.initialize(vulcanMessage);
    return message.getPayload();
};

/**
 * Gets all available endpoints of the running Vulcan-enabled applications.
 */
Vulcan.prototype.getEndPoints = function() {
    try {
        var str = window.__adobe_cep__.invokeSync("vulcanGetEndPoints", "");
        return JSON.parse(str);
    } catch (e) {
        return [];
    }
};

/**
 * Gets the endpoint for itself.
 */
Vulcan.prototype.getSelfEndPoint = function() {
    try {
        return window.__adobe_cep__.invokeSync("vulcanGetSelfEndPoint", "");
    } catch (e) {
        return "";
    }
};

/** Singleton instance of the Vulcan class. */
var VulcanInterface = new Vulcan();

/**
 * @class VulcanMessage
 * Message type for sending messages between host applications.
 */
function VulcanMessage(type, appId, appVersion) {
    this.type = type;
    this.scope = VulcanMessage.SCOPE_SUITE;
    this.appId = appId || null;
    this.appVersion = appVersion || null;
    this.data = VulcanMessage.DEFAULT_DATA;
}

VulcanMessage.TYPE_PREFIX = "vulcan.SuiteMessage.";
VulcanMessage.SCOPE_SUITE = "GLOBAL";
VulcanMessage.DEFAULT_DATA = "<data><payload></payload></data>";
VulcanMessage.dataTemplate = "<data>{0}</data>";
VulcanMessage.payloadTemplate = "<payload>{0}</payload>";

VulcanMessage.prototype.initialize = function(message) {
    if (!message) return;
    this.type = message.type;
    this.scope = message.scope;
    this.appId = message.appId;
    this.appVersion = message.appVersion;
    this.data = message.data;
};

/** Gets the payload of the message. */
VulcanMessage.prototype.getPayload = function() {
    var str = this.data;
    if (str) {
        var start = str.indexOf("<payload>");
        var end = str.indexOf("</payload>");
        if (start >= 0 && end > start) {
            return str.substring(start + 9, end);
        }
    }
    return null;
};

/** Sets the payload of the message. */
VulcanMessage.prototype.setPayload = function(payload) {
    this.data = VulcanMessage.dataTemplate.replace(
        "{0}",
        VulcanMessage.payloadTemplate.replace("{0}", payload)
    );
};

/* Expose globally for classic script loading in CEP. */
window.Vulcan = Vulcan;
window.VulcanInterface = VulcanInterface;
window.VulcanMessage = VulcanMessage;
