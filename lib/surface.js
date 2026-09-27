const { EventHub, disposeAll } = require("./event-hub");

const EVENT_METHODS = Object.freeze({
  popup: "onDidRequestPopup",
  "popup-blocked": "onDidBlockPopup",
  destroyed: "onDidDestroy",
  "external-protocol": "onDidRequestExternalProtocol",
  "context-menu": "onDidRequestContextMenu",
  permission: "onDidRequestPermission",
  device: "onDidRequestDevice",
  "device-updated": "onDidUpdateDevice",
  "device-revoked": "onDidRevokeDevice",
  "request-expired": "onDidExpireRequest",
  authentication: "onDidRequestAuthentication",
  "download-start": "onDidStartDownload",
  "download-update": "onDidUpdateDownload",
  "download-finish": "onDidFinishDownload",
  "find-result": "onDidFindInPage",
  crash: "onDidCrash",
  shortcut: "onDidReceiveShortcut",
});

const RESPONSE_METHODS = Object.freeze({
  popup: "respondToPopup",
  permission: "respondToPermission",
  device: "respondToDevice",
  authentication: "respondToAuthentication",
  download: "respondToDownload",
  "context-menu": "respondToContextMenu",
});

function detailOf(value) {
  return value && typeof value === "object" && "detail" in value ? value.detail : value;
}

class BrowserSurface {
  static async create(options, windowService = globalThis.lumine?.window) {
    if (typeof windowService?.createWebContentsView !== "function") {
      throw new Error("This version of Lumine does not provide WebContentsView surfaces.");
    }
    const raw = await windowService.createWebContentsView(options);
    return new BrowserSurface(raw);
  }

  constructor(raw) {
    if (!raw) throw new TypeError("A core WebContentsView handle is required");
    this.raw = raw;
    this.events = new EventHub();
    this.subscriptions = [];
    this.state = typeof raw.getState === "function" ? raw.getState() || {} : {};
    this.destroyed = false;
    this.destroyPromise = null;
    this.subscribe();
  }

  subscribe() {
    if (typeof this.raw.onDidChangeState === "function") {
      this.subscriptions.push(
        this.raw.onDidChangeState((state) => {
          this.state = { ...this.state, ...detailOf(state) };
          this.events.emit("state", this.getState());
        }),
      );
    }

    for (const [type, method] of Object.entries(EVENT_METHODS)) {
      if (typeof this.raw[method] === "function") {
        this.subscriptions.push(
          this.raw[method]((detail) => {
            if (type === "destroyed") this.destroyFromCore(detailOf(detail));
            else this.events.emit(type, detailOf(detail));
          }),
        );
      } else if (
        typeof this.raw.onDidReceiveEvent === "function" &&
        this.raw.onDidReceiveEvent.length >= 2
      ) {
        this.subscriptions.push(
          this.raw.onDidReceiveEvent(type, (detail) => this.events.emit(type, detailOf(detail))),
        );
      }
    }

    if (typeof this.raw.onDidEvent === "function") {
      this.subscriptions.push(
        this.raw.onDidEvent((event) => this.events.emit(event.type, detailOf(event))),
      );
    } else if (
      typeof this.raw.onDidReceiveEvent === "function" &&
      this.raw.onDidReceiveEvent.length < 2
    ) {
      this.subscriptions.push(
        this.raw.onDidReceiveEvent((event) => this.events.emit(event.type, detailOf(event))),
      );
    }
  }

  getState() {
    return { ...this.state };
  }

  onDidChangeState(callback) {
    return this.events.on("state", callback);
  }

  on(type, callback) {
    return this.events.on(type, callback);
  }

  invoke(method, ...args) {
    if (this.destroyed || typeof this.raw[method] !== "function") return undefined;
    return this.raw[method](...args);
  }

  attach(element) {
    return this.invoke("attach", element);
  }

  detach() {
    return this.invoke("detach");
  }

  focus() {
    return this.invoke("focus");
  }

  registerOverlay(element) {
    return this.invoke("registerOverlay", element) || { dispose() {} };
  }

  respond(type, requestId, response) {
    if (this.destroyed || !this.raw) return undefined;
    const method = RESPONSE_METHODS[type];
    if (method && typeof this.raw[method] === "function")
      return this.raw[method](requestId, response);
    if (typeof this.raw.respondToEvent === "function")
      return this.raw.respondToEvent(type, requestId, response);
    if (typeof this.raw.respond === "function")
      return this.raw.respond({ type, requestId, response });
    return undefined;
  }

  destroyFromCore(detail) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyPromise = Promise.resolve();
    disposeAll(this.subscriptions);
    this.subscriptions = [];
    try {
      this.events.emit("destroyed", detail);
    } finally {
      this.events.dispose();
      this.raw = null;
    }
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    disposeAll(this.subscriptions);
    this.subscriptions = [];
    const raw = this.raw;
    this.raw = null;
    try {
      this.destroyPromise = Promise.resolve(raw?.destroy?.()).finally(() => {
        this.events.dispose();
      });
    } catch (error) {
      this.events.dispose();
      this.destroyPromise = Promise.reject(error);
    }
    void this.destroyPromise.catch(() => {});
    return this.destroyPromise;
  }
}

for (const method of [
  "loadURL",
  "setVisible",
  "goBack",
  "goForward",
  "reload",
  "reloadIgnoringCache",
  "stop",
  "findInPage",
  "stopFindInPage",
  "setZoomFactor",
  "setUserAgent",
  "print",
  "capturePage",
  "openDevTools",
  "closeDevTools",
  "inspectElement",
  "copy",
  "cut",
  "paste",
  "undo",
  "redo",
  "selectAll",
  "replaceMisspelling",
  "addWordToDictionary",
  "setDeviceEmulation",
  "clearDeviceEmulation",
  "clearBrowsingData",
  "setPermissionDecision",
  "cancelDownload",
]) {
  BrowserSurface.prototype[method] = function (...args) {
    return this.invoke(method, ...args);
  };
}

module.exports = { BrowserSurface, EVENT_METHODS, RESPONSE_METHODS };
