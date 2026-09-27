const crypto = require("crypto");
const { fileURLToPath } = require("url");
const { Emitter, CompositeDisposable, watchFile } = require("lumine");
const { BrowserSurface } = require("./surface");
const { normalizeStorageScope, profileFor } = require("./profiles");
const { webDocumentPath } = require("./url-parser");

const VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function filePathForURL(url) {
  if (typeof url !== "string" || !url.startsWith("file:")) return null;
  try {
    const filePath = fileURLToPath(url);
    return webDocumentPath(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

function profileMatchesScope(profile, storageScope) {
  if (!profile || typeof profile !== "object") return false;
  const expectedScope = storageScope === "default" ? "global" : storageScope;
  if (profile.scope !== expectedScope) return false;
  if (expectedScope === "global") {
    return profile.persistent === true && profile.id === "web-browser/global";
  }
  if (expectedScope === "workspace") {
    return profile.persistent === true && /^web-browser\/workspace\/[0-9a-f]{24}$/.test(profile.id);
  }
  return (
    profile.persistent === false &&
    typeof profile.id === "string" &&
    /^web-browser\/tab\/[a-z0-9._-]+$/i.test(profile.id)
  );
}

class WebBrowserItem {
  constructor(options = {}) {
    this.package = options.package;
    this.id = UUID_PATTERN.test(options.id) ? options.id : crypto.randomUUID();
    this.url = options.url || "";
    this.title = options.title || (this.url ? this.url : "New Tab");
    this.storageScope = normalizeStorageScope(options.storageScope);
    this.projectPaths = Object.freeze([
      ...(options.projectPaths || globalThis.lumine?.project?.getPaths?.() || []),
    ]);
    this.profile = Object.freeze(
      (profileMatchesScope(options.profile, this.storageScope) && options.profile) ||
        profileFor(this.storageScope, {
          tabId: this.id,
          projectPaths: this.projectPaths,
        }),
    );
    this.autoReload = options.autoReload !== false;
    this.filePath = options.filePath || filePathForURL(this.url);
    this.surface = options.surface || null;
    this.adoptedSurface = Boolean(options.surface);
    this.surfacePromise = null;
    this.navigationGeneration = 0;
    this.view = null;
    this.destroyed = false;
    this.destroyPromise = null;
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
    if (!state || state.version !== VERSION || !UUID_PATTERN.test(state.id)) return undefined;
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
    };
  }

  copy() {
    return new WebBrowserItem({
      package: this.package,
      url: this.url,
      title: this.title,
      storageScope: this.storageScope,
      ...(this.profile.persistent ? { profile: this.profile } : {}),
      projectPaths: this.projectPaths,
      filePath: this.filePath,
      autoReload: this.autoReload,
    });
  }

  getProfile() {
    return this.profile;
  }

  async ensureSurface() {
    if (this.surface) return this.surface;
    if (this.surfacePromise) return this.surfacePromise;
    this.surfacePromise = BrowserSurface.create({
      profile: this.getProfile(),
      userAgent: this.package?.cleanUserAgent(),
    }).then(async (surface) => {
      if (this.destroyed) {
        await surface.destroy();
        throw new Error("Browser item was destroyed while its surface was being created");
      }
      this.surface = surface;
      this.bindSurface(surface);
      await this.package?.hydratePermissionDecisions(this, surface);
      if (this.destroyed) {
        surface.destroy();
        if (this.surface === surface) this.surface = null;
        throw new Error("Browser item was destroyed while its permissions were restored");
      }
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
      surface.on("popup-blocked", (event) => this.package?.handlePopupBlocked(this, event)),
      surface.on("destroyed", (event) => this.package?.handleSurfaceDestroyed(this, event)),
      surface.on("external-protocol", (event) => this.package?.handleExternalProtocol(this, event)),
      surface.on("context-menu", (event) => this.package?.handleContextMenu(this, event)),
      surface.on("permission", (event) => this.package?.handlePermission(this, event)),
      surface.on("device", (event) => this.package?.handleDeviceRequest(this, event)),
      surface.on("device-updated", (event) => this.package?.handleDeviceUpdate(this, event)),
      surface.on("device-revoked", (event) => this.package?.handleDeviceRevoked(this, event)),
      surface.on("request-expired", (event) => this.package?.handleRequestExpired(this, event)),
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
      void this.package?.syncFavorite(this);
    }
  }

  async navigate(url, { explicit = true } = {}) {
    this.navigationGeneration++;
    this.url = url;
    this.emitter.emit("did-navigate", url);
    const surface = await this.ensureSurface();
    surface.setVisible(true);
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
    if (this.destroyPromise) return this.destroyPromise;
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    const pendingSurface = this.surfacePromise;
    // Requests owned by a native surface must be answered before that surface
    // is destroyed. Core also has timeouts, but settling here closes the native
    // callback immediately and prevents package UI from outliving its tab.
    this.package?.cleanupItemRequests?.(this);
    if (this.pendingContextMenu) {
      this.surface?.respond("context-menu", this.pendingContextMenu.requestId, null);
      this.pendingContextMenu = null;
    }
    this.fileSubscriptions.dispose();
    this.subscriptions.dispose();
    this.view?.destroy();
    this.view = null;
    const nativeCleanup = this.surface?.destroy();
    this.surface = null;
    this.package?.items?.delete(this);
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
    const pendingSurfaceCleanup = pendingSurface
      ? pendingSurface.then(
          (surface) => surface.destroy(),
          () => undefined,
        )
      : undefined;
    this.destroyPromise = Promise.all([
      Promise.resolve(nativeCleanup),
      Promise.resolve(pendingSurfaceCleanup),
    ]).then(() => undefined);
    void this.destroyPromise.catch(() => {});
    return this.destroyPromise;
  }
}

module.exports = { VERSION, WebBrowserItem };
