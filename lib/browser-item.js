const crypto = require("crypto");
const { Emitter, CompositeDisposable, watchFile } = require("lumine");
const { BrowserSurface } = require("./surface");
const { normalizeStorageScope, profileFor } = require("./profiles");

const VERSION = 1;

class WebBrowserItem {
  constructor(options = {}) {
    this.package = options.package;
    this.id = options.id || crypto.randomUUID();
    this.url = options.url || "";
    this.title = options.title || (this.url ? this.url : "New Tab");
    this.storageScope = normalizeStorageScope(options.storageScope);
    this.autoReload = options.autoReload !== false;
    this.filePath = options.filePath || null;
    this.surface = options.surface || null;
    this.surfacePromise = null;
    this.view = null;
    this.destroyed = false;
    this.lastSurfaceState = {};
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.fileSubscriptions = new CompositeDisposable();
    this.package?.items?.add(this);
    if (this.surface) {
      this.lastSurfaceState = this.surface.getState();
      this.bindSurface(this.surface);
    }
    if (this.filePath && this.autoReload) this.watchLocalFile();
  }

  static deserialize(state, packageController) {
    if (!state || state.version !== VERSION || typeof state.id !== "string") return undefined;
    return new WebBrowserItem({ ...state, package: packageController });
  }

  getURI() {
    return `web-browser://tab/${this.id}`;
  }

  getTitle() {
    return this.title || "New Tab";
  }

  getLongTitle() {
    return this.url || this.getTitle();
  }

  getIconName() {
    return "globe";
  }

  getDefaultLocation() {
    return "center";
  }

  getAllowedLocations() {
    return ["center"];
  }

  serialize() {
    return {
      deserializer: "WebBrowserItem",
      version: VERSION,
      id: this.id,
      url: this.url,
      title: this.title,
      storageScope: this.storageScope,
      filePath: this.filePath,
      autoReload: this.autoReload,
    };
  }

  copy() {
    return new WebBrowserItem({
      package: this.package,
      url: this.url,
      title: this.title,
      storageScope: this.storageScope,
      filePath: this.filePath,
      autoReload: this.autoReload,
    });
  }

  getProfile() {
    return profileFor(this.storageScope, {
      tabId: this.id,
      projectPaths: globalThis.lumine?.project?.getPaths?.() || [],
    });
  }

  async ensureSurface() {
    if (this.surface) return this.surface;
    if (this.surfacePromise) return this.surfacePromise;
    this.surfacePromise = BrowserSurface.create({
      profile: this.getProfile(),
      userAgent: this.package?.cleanUserAgent(),
    }).then((surface) => {
      if (this.destroyed) {
        surface.destroy();
        throw new Error("Browser item was destroyed while its surface was being created");
      }
      this.surface = surface;
      this.bindSurface(surface);
      void this.package?.hydratePermissionDecisions(this, surface);
      return surface;
    });
    try {
      return await this.surfacePromise;
    } finally {
      this.surfacePromise = null;
    }
  }

  bindSurface(surface) {
    this.subscriptions.add(
      surface.onDidChangeState((state) => this.updateFromSurface(state)),
      surface.on("popup", (event) => this.package?.handlePopup(this, event)),
      surface.on("external-protocol", (event) => this.package?.handleExternalProtocol(this, event)),
      surface.on("context-menu", (event) => this.package?.handleContextMenu(this, event)),
      surface.on("permission", (event) => this.package?.handlePermission(this, event)),
      surface.on("device", (event) => this.package?.handleDeviceRequest(this, event)),
      surface.on("authentication", (event) => this.package?.handleAuthentication(this, event)),
      surface.on("download-start", (event) => this.package?.handleDownload(this, event)),
      surface.on("download-update", (event) => this.package?.handleDownloadUpdate(this, event)),
      surface.on("download-finish", (event) => this.package?.handleDownloadFinish(this, event)),
      surface.on("find-result", (event) => this.view?.updateFindResult(event)),
      surface.on("crash", (event) => this.view?.showCrash(event)),
    );
  }

  updateFromSurface(state = {}) {
    const previousURL = this.url;
    this.lastSurfaceState = { ...this.lastSurfaceState, ...state };
    if (typeof state.url === "string" && state.url !== "about:blank") this.url = state.url;
    const nextTitle = state.title || (this.url ? this.url : "New Tab");
    if (nextTitle !== this.title) {
      this.title = nextTitle;
      this.emitter.emit("did-change-title", this.title);
      void this.package?.recordNavigation(this, false);
    }
    this.view?.renderState(this.lastSurfaceState);
    if (this.url && this.url !== previousURL) {
      this.emitter.emit("did-navigate", this.url);
      void this.package?.recordNavigation(this, false);
    }
  }

  async navigate(url, { explicit = true } = {}) {
    this.url = url;
    this.emitter.emit("did-navigate", url);
    const surface = await this.ensureSurface();
    const result = await surface.loadURL(url);
    if (explicit) this.package?.recordNavigation(this, true);
    return result;
  }

  async focus() {
    const surface = await this.ensureSurface();
    this.view?.element?.focus();
    return surface.focus();
  }

  setView(view) {
    this.view = view;
  }

  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  onDidNavigate(callback) {
    return this.emitter.on("did-navigate", callback);
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  watchLocalFile() {
    this.fileSubscriptions.dispose();
    this.fileSubscriptions = new CompositeDisposable();
    try {
      const file = watchFile(this.filePath);
      this.fileSubscriptions.add(
        file,
        file.onDidChange(() => {
          if (this.autoReload && lumine.config.get("web-browser.autoReloadOnFileChange")) {
            void this.surface?.reload();
          }
        }),
      );
    } catch (error) {
      console.warn("Unable to watch local web document", error);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.fileSubscriptions.dispose();
    this.subscriptions.dispose();
    this.view?.destroy();
    this.view = null;
    this.surface?.destroy();
    this.surface = null;
    this.package?.items?.delete(this);
    this.package?.updateTitleBarTile?.();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

module.exports = { VERSION, WebBrowserItem };
