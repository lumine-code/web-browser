const path = require("path");
const { pathToFileURL } = require("url");
const { CompositeDisposable, Disposable } = require("lumine");
const { WebBrowserItem } = require("./browser-item");
const WebBrowserView = require("./browser-view");
const { BrowserSurface } = require("./surface");
const { BrowserDataStore } = require("./data-store");
const { canPersistSiteDecision, workspaceKey } = require("./profiles");
const {
  isLocalWebURL,
  parseAddressInput,
  safeSuggestedFilename,
  webDocumentPath,
} = require("./url-parser");

function isBrowserItem(item) {
  return item instanceof WebBrowserItem;
}

function icon(name) {
  const node = document.createElement("span");
  node.className = `icon icon-${name}`;
  return node;
}

const WebBrowserPackage = {
  items: new Set(),
  subscriptions: null,
  dataStore: null,
  treeView: null,
  titleBar: null,
  titleBarTile: null,
  lastBrowserItem: null,
  lastNonBrowserItem: null,
  downloads: new Map(),

  ensureState() {
    this.items ||= new Set();
    this.downloads ||= new Map();
    this.dataStore ||= new BrowserDataStore();
  },

  activate() {
    this.ensureState();
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.views.addViewProvider(WebBrowserItem, (item) => new WebBrowserView(item).element),
      lumine.workspace.addOpener((uri) => this.openURI(uri)),
      lumine.workspace.observeActivePaneItem((item) => {
        if (isBrowserItem(item)) this.lastBrowserItem = item;
        else if (item) this.lastNonBrowserItem = item;
        this.updateTitleBarTile();
      }),
      lumine.config.onDidChange("web-browser.showInTitleBar", () => this.updateTitleBarTile()),
      lumine.externalURIs?.addOpener?.(
        async (uri) => {
          if (!lumine.config.get("web-browser.openLocalhostLinks") || !isLocalWebURL(uri)) {
            return false;
          }
          await this.open(uri);
          return true;
        },
        { priority: 100 },
      ) || new Disposable(),
      lumine.commands.add("lumine-workspace", this.commands()),
      lumine.commands.add(".web-browser", this.contextCommands()),
    );
  },

  async deactivate() {
    this.titleBarTile?.destroy?.();
    this.titleBarTile = null;
    const closures = [];
    for (const item of [...this.items]) {
      const pane = lumine.workspace.paneForItem(item);
      if (pane) closures.push(pane.destroyItem(item, true));
      else item.destroy();
    }
    await Promise.allSettled(closures);
    this.subscriptions?.dispose();
    this.subscriptions = null;
    this.items.clear();
    this.dataStore?.close();
    this.dataStore = null;
    this.treeView = null;
    this.titleBar = null;
    this.downloads.clear();
  },

  deserialize(state) {
    this.ensureState();
    return WebBrowserItem.deserialize(state, this);
  },

  handleURI(parsedURI) {
    const raw = parsedURI?.query?.url;
    const scope = parsedURI?.query?.storageScope;
    if (typeof raw === "string") void this.open(raw, { storageScope: scope });
    else void this.open();
  },

  openURI(uri) {
    if (typeof uri !== "string") return undefined;
    if (/^https?:\/\//i.test(uri) || /^file:\/\//i.test(uri)) {
      return new WebBrowserItem({ package: this, url: uri });
    }
    return undefined;
  },

  async open(url = "", options = {}) {
    this.ensureState();
    if (url) {
      const parsed = parseAddressInput(url, {
        searchEngine: lumine.config.get("web-browser.searchEngine"),
      });
      if (!parsed.url || parsed.kind === "invalid") throw new Error(parsed.reason || "Invalid URL");
      url = parsed.url === "about:blank" ? "" : parsed.url;
    }
    const item = new WebBrowserItem({
      package: this,
      url,
      storageScope: options.storageScope || lumine.config.get("web-browser.dataStorage"),
      autoReload: options.autoReload,
      filePath: options.filePath,
    });
    const placement = options.placement || lumine.config.get("web-browser.newTabPlacement");
    if (placement === "window") {
      const query = new URLSearchParams({ url, storageScope: item.storageScope });
      lumine.application.openWindow({
        newWindow: true,
        urlsToOpen: [`lumine://web-browser/open?${query}`],
        devMode: lumine.devMode,
        safeMode: lumine.safeMode,
      });
      item.destroy();
      return item;
    }
    const openOptions = {
      activateItem: options.activate !== false,
      ...(placement === "side-pane" ? { split: "right" } : {}),
    };
    await lumine.workspace.open(item, openOptions);
    this.lastBrowserItem = item;
    this.updateTitleBarTile();
    return item;
  },

  openFile(filePath, options = {}) {
    if (!path.isAbsolute(filePath))
      throw new TypeError("A local web document path must be absolute");
    if (!webDocumentPath(filePath)) throw new Error("Only HTML and MHTML documents can be opened");
    return this.open(pathToFileURL(filePath).toString(), {
      ...options,
      filePath,
      autoReload: options.autoReload !== false,
    });
  },

  provideWebBrowser() {
    return {
      open: this.open.bind(this),
      openFile: this.openFile.bind(this),
      getItems: () => [...this.items],
      getActiveItem: () => this.activeItem(),
    };
  },

  provideBackgroundTips() {
    return {
      packageName: "web-browser",
      tips: [
        "You can bring the web browser forward or return to your editor with {{ 'web-browser:toggle-focus' | keystroke }}",
      ],
    };
  },

  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => {
      if (this.treeView === treeView) this.treeView = null;
    });
  },

  consumeTitleBar(titleBar) {
    this.titleBar = titleBar;
    const tile = document.createElement("title-bar-tile");
    tile.className = "web-browser-title-bar-button";
    tile.title = "Web Browser";
    tile.setAttribute("aria-label", "Web Browser");
    tile.appendChild(icon("globe"));
    tile.addEventListener("click", () => this.openOrList());
    this.titleBarTile = titleBar.addItem({ item: tile, priority: 15 });
    this.updateTitleBarTile();
    return new Disposable(() => {
      if (this.titleBar !== titleBar) return;
      this.titleBarTile?.destroy?.();
      this.titleBarTile = null;
      this.titleBar = null;
    });
  },

  updateTitleBarTile() {
    const element = this.titleBarTile?.getItem?.();
    if (!element) return;
    const setting = lumine.config.get("web-browser.showInTitleBar");
    element.hidden = setting === "never" || (setting === "when-open" && this.items.size === 0);
  },

  cleanUserAgent() {
    return String(globalThis.window?.navigator?.userAgent || "")
      .replace(/\sElectron\/[^\s]+/gi, "")
      .replace(/\sLumine\/[^\s]+/gi, "")
      .trim();
  },

  activeItem(event) {
    const fromTarget = event?.target?.closest?.(".web-browser")?.webBrowserItem;
    if (isBrowserItem(fromTarget)) return fromTarget;
    const active = lumine.workspace.getActivePaneItem();
    return isBrowserItem(active) ? active : null;
  },

  requireItem(event, action) {
    const item = this.activeItem(event);
    if (item) return item;
    lumine.notifications.addWarning(`Cannot ${action}`, {
      detail: "Focus a Web Browser tab first.",
      dismissable: true,
    });
    return null;
  },

  commands() {
    const withItem = (action, callback) => ({
      description: `${action} in the active web browser tab.`,
      didDispatch: (event) => {
        const item = this.requireItem(event, action.toLowerCase());
        if (item) return callback(item, event);
      },
    });
    return {
      "web-browser:toggle-focus": {
        description: "Focus the last web browser tab, or return to the previous editor.",
        didDispatch: () => this.toggleFocus(),
      },
      "web-browser:new-tab": {
        description: "Open a new web browser tab.",
        didDispatch: () => this.open(),
      },
      "web-browser:quick-open": {
        description: "Choose an open web browser tab.",
        didDispatch: () => this.quickOpen(),
      },
      "web-browser:focus-address": withItem("Focus Address", (item) => item.view?.focusAddress()),
      "web-browser:back": withItem("Go Back", (item) => item.surface?.goBack()),
      "web-browser:forward": withItem("Go Forward", (item) => item.surface?.goForward()),
      "web-browser:reload": withItem("Reload", (item) => this.reload(item)),
      "web-browser:reload-ignoring-cache": withItem("Reload Without Cache", (item) =>
        item.surface?.reloadIgnoringCache(),
      ),
      "web-browser:stop": withItem("Stop Loading", (item) => item.surface?.stop()),
      "web-browser:stop-or-dismiss": withItem("Stop or Dismiss", (item) =>
        this.stopOrDismiss(item),
      ),
      "web-browser:find": withItem("Find", (item) => item.view?.showFind()),
      "web-browser:toggle-favorite": withItem("Toggle Favorite", (item) =>
        this.toggleFavorite(item),
      ),
      "web-browser:show-history": {
        description: "Search browser history.",
        didDispatch: () => this.showHistory(),
      },
      "web-browser:open-external": withItem("Open Externally", (item) => this.openExternal(item)),
      "web-browser:print": withItem("Print", (item) => item.surface?.print()),
      "web-browser:zoom-in": withItem("Zoom In", (item) => this.zoom(item, 0.1)),
      "web-browser:zoom-out": withItem("Zoom Out", (item) => this.zoom(item, -0.1)),
      "web-browser:zoom-reset": withItem("Reset Zoom", (item) =>
        this.setZoom(item, lumine.config.get("web-browser.pageZoom") || 1),
      ),
      "web-browser:toggle-responsive": withItem("Toggle Responsive Mode", (item) =>
        item.view?.toggleResponsive(),
      ),
      "web-browser:open-devtools": withItem("Open DevTools", (item) =>
        item.surface?.openDevTools(),
      ),
      "web-browser:show-site-permissions": withItem("Show Site Permissions", (item) =>
        this.showSitePermissions(item),
      ),
      "web-browser:clear-browsing-data": withItem("Clear Browsing Data", (item) =>
        this.clearBrowsingData(item),
      ),
      "web-browser:close-all": {
        description: "Close every web browser tab.",
        didDispatch: () => this.closeAll(),
      },
      "web-browser:open-file": {
        description: "Open this HTML document in the web browser.",
        didDispatch: (event) => this.openSelectedFile(event),
      },
    };
  },

  contextCommands() {
    const reply = (action) => (event) => this.replyContext(this.activeItem(event), action);
    const commands = {
      "web-browser:context-back": reply("back"),
      "web-browser:context-forward": reply("forward"),
      "web-browser:context-reload": reply("reload"),
      "web-browser:context-copy": reply("copy"),
      "web-browser:context-cut": reply("cut"),
      "web-browser:context-paste": reply("paste"),
      "web-browser:context-select-all": reply("selectAll"),
      "web-browser:context-inspect": reply("inspect"),
      "web-browser:context-open-link": (event) => this.openContextLink(this.activeItem(event)),
      "web-browser:context-open-link-external": (event) =>
        this.openContextLinkExternal(this.activeItem(event)),
      "web-browser:context-open-image-external": (event) =>
        this.openContextImageExternal(this.activeItem(event)),
      "web-browser:context-add-dictionary": (event) => this.addContextWord(this.activeItem(event)),
    };
    for (let index = 0; index < 5; index++) {
      commands[`web-browser:context-spelling-${index}`] = (event) =>
        this.replaceContextSpelling(this.activeItem(event), index);
    }
    return commands;
  },

  async toggleFocus() {
    const active = lumine.workspace.getActivePaneItem();
    if (isBrowserItem(active)) {
      if (this.lastNonBrowserItem) {
        await lumine.workspace.open(this.lastNonBrowserItem, { searchAllPanes: true });
        lumine.views.getView(this.lastNonBrowserItem)?.focus?.();
      } else active.view?.focusAddress();
      return;
    }
    const item =
      this.lastBrowserItem && this.items.has(this.lastBrowserItem)
        ? this.lastBrowserItem
        : [...this.items].at(-1);
    if (item) {
      await lumine.workspace.open(item, { searchAllPanes: true });
      await item.focus();
    } else await this.open();
  },

  openOrList() {
    if (this.items.size <= 1) return this.toggleFocus();
    return this.quickOpen();
  },

  async quickOpen() {
    const items = [...this.items];
    if (!items.length) return this.open();
    return this.showList({
      items,
      emptyMessage: "No browser tabs are open",
      getId: (item) => item.id,
      label: (item) => item.getTitle(),
      detail: (item) => item.url,
      onConfirm: async (item) => {
        await lumine.workspace.open(item, { searchAllPanes: true });
        await item.focus();
      },
    });
  },

  async addressSuggestions(item, query) {
    const workspace = workspaceKey(lumine.project.getPaths());
    const profile = item.getProfile();
    const favorites = (await this.dataStore.favorites(workspace))
      .filter((entry) => !query || entry.url.toLowerCase().includes(query))
      .slice(0, 8)
      .map((entry) => ({ label: entry.url, run: () => item.navigate(entry.url) }));
    const open = [...this.items]
      .filter((candidate) => candidate !== item)
      .filter(
        (candidate) =>
          !query || `${candidate.title} ${candidate.url}`.toLowerCase().includes(query),
      )
      .slice(0, 8)
      .map((candidate) => ({
        label: candidate.getTitle(),
        detail: candidate.url,
        run: async () => {
          await lumine.workspace.open(candidate, { searchAllPanes: true });
          candidate.focus();
        },
      }));
    const history = (await this.dataStore.history(profile, { query, limit: query ? 6 : 3 })).map(
      (entry) => ({
        label: entry.title,
        detail: entry.url,
        run: () => item.navigate(entry.url),
      }),
    );
    const action = [];
    if (query) {
      const parsed = parseAddressInput(item.view?.addressInput.value || query, {
        searchEngine: lumine.config.get("web-browser.searchEngine"),
      });
      if (parsed.url)
        action.push({
          label: parsed.kind === "search" ? `Search for ${parsed.query}` : `Open ${parsed.url}`,
          run: () => item.navigate(parsed.url),
        });
    }
    return [
      { label: "Favorites", items: favorites },
      { label: "Open Tabs", items: open },
      { label: query ? "History" : "Recents", items: history },
      { label: "Go", items: action },
    ];
  },

  async recordNavigation(item, explicit) {
    if (!item.url) return;
    await this.dataStore.addHistory(
      item.getProfile(),
      { url: item.url, title: item.title, explicit },
      lumine.config.get("web-browser.maxHistoryEntries"),
    );
  },

  async toggleFavorite(item) {
    if (!item.url) return;
    const key = workspaceKey(lumine.project.getPaths());
    const favorite = await this.dataStore.toggleFavorite(key, item.url);
    item.view?.updateFavorite(favorite);
  },

  async showHistory() {
    const item = this.activeItem() || this.lastBrowserItem;
    const profile = item?.getProfile();
    const entries = profile ? await this.dataStore.history(profile) : [];
    return this.showList({
      items: entries,
      emptyMessage: profile?.persistent
        ? "Browser history is empty"
        : "History is disabled for private tabs",
      getId: (entry) => entry.id,
      label: (entry) => entry.title,
      detail: (entry) => new Date(entry.timestamp).toLocaleString() + " — " + entry.url,
      onConfirm: (entry) => this.open(entry.url),
    });
  },

  showList({ items, emptyMessage, getId, label, detail, onConfirm }) {
    const host = lumine.workspace.addSelectList(
      {
        items,
        emptyMessage,
        getItemId: getId,
        search: { getFilterText: (entry) => `${label(entry)} ${detail(entry) || ""}` },
        renderItem: (entry, { highlight }) => ({
          icon: ["icon-globe"],
          primary: highlight(label(entry)),
          secondary: detail(entry),
        }),
        commands: {
          "web-browser:confirm-list": ({ detail: eventDetail }) => {
            Promise.resolve(onConfirm(eventDetail.item)).finally(() => host.destroy());
          },
        },
        actions: [
          {
            command: "web-browser:confirm-list",
            context: "item",
            primary: true,
            disposition: "stay",
            dispatch: "local",
          },
        ],
      },
      { className: "web-browser-list" },
    );
    host.onDidCancel(() => host.destroy());
    host.show();
    return host;
  },

  reload(item) {
    if (item.lastSurfaceState.loading) return item.surface?.stop();
    return item.surface?.reload();
  },

  stopOrDismiss(item) {
    if (!item.view?.picker.hidden) item.view.hidePicker();
    else if (!item.view?.findBar.hidden) item.view.hideFind();
    else if (item.lastSurfaceState.loading) item.surface?.stop();
    else item.surface?.focus();
  },

  zoom(item, delta) {
    return this.setZoom(
      item,
      Math.max(0.25, Math.min(5, (item.lastSurfaceState.zoomFactor || 1) + delta)),
    );
  },

  setZoom(item, factor) {
    return item.surface?.setZoomFactor(Math.round(factor * 100) / 100);
  },

  openExternal(item) {
    if (item?.url) return lumine.shell.openExternal(item.url);
  },

  openSelectedFile(event) {
    let filePath;
    const editor = event?.target?.closest?.("lumine-text-editor:not([mini])")?.getModel?.();
    filePath = editor?.getPath?.();
    if (!filePath) filePath = this.treeView?.selectedPaths?.()[0];
    if (!filePath || !webDocumentPath(filePath)) {
      lumine.notifications.addWarning("Cannot open in Web Browser", {
        detail: "Select an HTML or MHTML document.",
        dismissable: true,
      });
      return;
    }
    return this.openFile(filePath);
  },

  closeAll() {
    return Promise.all(
      [...this.items].map(
        (item) => lumine.workspace.paneForItem(item)?.destroyItem(item, true) || item.destroy(),
      ),
    );
  },

  async handlePopup(parent, event = {}) {
    const rawSurface = event.surface;
    const surface =
      rawSurface instanceof BrowserSurface
        ? rawSurface
        : rawSurface
          ? new BrowserSurface(rawSurface)
          : null;
    const item = new WebBrowserItem({
      package: this,
      url: event.url || "",
      storageScope: parent.storageScope,
      surface,
    });
    const pane = lumine.workspace.paneForItem(parent);
    try {
      await (pane
        ? pane.addItem(item, { index: pane.getActiveItemIndex() + 1 })
        : lumine.workspace.open(item));
      if (!/background/i.test(event.disposition || "")) pane?.activateItem(item);
      parent.surface.respond("popup", event.requestId, { accept: true });
    } catch (error) {
      parent.surface.respond("popup", event.requestId, { accept: false });
      item.destroy();
      throw error;
    }
  },

  handleExternalProtocol(_item, event = {}) {
    const url = event.url;
    if (!/^mailto:/i.test(url || "")) {
      lumine.notifications.addWarning("Blocked external protocol", {
        detail: url,
        dismissable: true,
      });
      return;
    }
    const notification = lumine.notifications.addInfo("Open link in an external application?", {
      detail: url,
      dismissable: true,
      buttons: [
        {
          text: "Open",
          className: "btn-primary",
          onDidClick: () => {
            notification.dismiss();
            void lumine.shell.openExternal(url);
          },
        },
        { text: "Cancel", onDidClick: () => notification.dismiss() },
      ],
    });
  },

  async handlePermission(item, event = {}) {
    const profile = item.getProfile();
    const saved = await this.dataStore.permission(profile, event.origin, event.permission);
    if (saved) {
      return item.surface.respond("permission", event.requestId, {
        allow: saved.decision === "allow",
        remember: true,
      });
    }
    let settled = false;
    let notification;
    const settle = async (allow, remember = false) => {
      if (settled) return;
      settled = true;
      if (remember && canPersistSiteDecision(profile)) {
        await this.dataStore.setPermission(
          profile,
          event.origin,
          event.permission,
          allow ? "allow" : "block",
        );
      }
      item.surface.respond("permission", event.requestId, { allow, remember });
      notification?.dismiss();
    };
    const buttons = [
      { text: "Allow Once", className: "btn-primary", onDidClick: () => settle(true) },
      ...(canPersistSiteDecision(profile)
        ? [{ text: "Always Allow", onDidClick: () => settle(true, true) }]
        : []),
      { text: "Block", onDidClick: () => settle(false, canPersistSiteDecision(profile)) },
    ];
    notification = lumine.notifications.addWarning(
      `${event.origin || "This site"} requests ${event.permission}`,
      {
        detail: "Allow only sites you trust.",
        dismissable: true,
        buttons,
      },
    );
    notification.onDidDismiss(() => settle(false));
  },

  async hydratePermissionDecisions(item, surface = item.surface) {
    const profile = item.getProfile();
    if (!profile.persistent || typeof surface?.setPermissionDecision !== "function") return;
    for (const entry of await this.dataStore.permissions(profile)) {
      await surface.setPermissionDecision(
        entry.origin,
        entry.permission,
        entry.decision === "allow",
      );
    }
  },

  handleDeviceRequest(item, event = {}) {
    const devices = event.devices || [];
    if (!devices.length) return item.surface.respond("device", event.requestId, { deviceId: null });
    this.showList({
      items: devices,
      emptyMessage: "No devices available",
      getId: (device) => device.deviceId,
      label: (device) => device.name || "Unnamed device",
      detail: (device) =>
        [device.vendorId, device.productId].filter((value) => value != null).join(":"),
      onConfirm: (device) =>
        item.surface.respond("device", event.requestId, { deviceId: device.deviceId }),
    });
  },

  handleAuthentication(item, event = {}) {
    const form = document.createElement("form");
    form.className = "web-browser-auth-dialog padded";
    const heading = document.createElement("h2");
    heading.textContent = `Sign in to ${event.host || event.url || "site"}`;
    const username = document.createElement("input");
    username.className = "input-text native-key-bindings";
    username.placeholder = "Username";
    const password = document.createElement("input");
    password.className = "input-text native-key-bindings";
    password.type = "password";
    password.placeholder = "Password";
    const submit = document.createElement("button");
    submit.className = "btn btn-primary";
    submit.type = "submit";
    submit.textContent = "Sign In";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    form.append(heading, username, password, submit, cancel);
    const panel = lumine.workspace.addModalPanel({ item: form, autoFocus: username });
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      item.surface.respond("authentication", event.requestId, response);
      panel.destroy();
    };
    form.addEventListener("submit", (submitEvent) => {
      submitEvent.preventDefault();
      finish({ username: username.value, password: password.value });
    });
    cancel.addEventListener("click", () => finish(null));
    panel.onDidDestroy(() => finish(null));
  },

  async handleDownload(item, event = {}) {
    const filename = safeSuggestedFilename(event.filename);
    const result = await lumine.window.showSaveDialog({
      title: "Save Download",
      defaultPath: path.join(lumine.application.getPath("downloads"), filename),
    });
    const filePath = result?.filePath;
    if (!filePath) return item.surface.respond("download", event.requestId, null);
    const notification = lumine.notifications.addInfo(`Downloading ${filename}`, {
      detail: filePath,
      dismissable: true,
      buttons: [
        {
          text: "Cancel",
          onDidClick: () => item.surface.cancelDownload(event.requestId),
        },
      ],
    });
    this.downloads.set(event.requestId, { notification, filePath, filename });
    item.surface.respond("download", event.requestId, { path: filePath });
  },

  handleDownloadUpdate(_item, event = {}) {
    const download = this.downloads.get(event.requestId);
    if (!download) return;
    const percent =
      event.totalBytes > 0 ? Math.round((event.receivedBytes / event.totalBytes) * 100) : null;
    download.notification.setDetail?.(
      `${download.filePath}${percent == null ? "" : ` — ${percent}%`}`,
    );
  },

  handleDownloadFinish(_item, event = {}) {
    const download = this.downloads.get(event.requestId);
    if (!download) return;
    this.downloads.delete(event.requestId);
    download.notification.dismiss();
    if (event.state !== "completed") {
      lumine.notifications.addWarning(`Download ${event.state || "failed"}`, {
        detail: download.filePath,
        dismissable: true,
      });
      return;
    }
    const notification = lumine.notifications.addSuccess(`Downloaded ${download.filename}`, {
      detail: download.filePath,
      dismissable: true,
      buttons: [
        {
          text: "Open",
          onDidClick: () => {
            notification.dismiss();
            void lumine.shell.openPath(download.filePath);
          },
        },
        {
          text: "Show in Folder",
          onDidClick: () => {
            notification.dismiss();
            void lumine.shell.showItemInFolder(download.filePath);
          },
        },
      ],
    });
  },

  handleContextMenu(item, event = {}) {
    item.pendingContextMenu = event;
    const template = [];
    if (event.misspelledWord) {
      for (const [index, suggestion] of (event.dictionarySuggestions || []).slice(0, 5).entries()) {
        template.push({ label: suggestion, command: `web-browser:context-spelling-${index}` });
      }
      template.push(
        { label: "Add to Dictionary", command: "web-browser:context-add-dictionary" },
        { type: "separator" },
      );
    }
    if (event.linkURL) {
      template.push(
        { label: "Open Link in New Tab", command: "web-browser:context-open-link" },
        { label: "Open Link Externally", command: "web-browser:context-open-link-external" },
        { type: "separator" },
      );
    }
    if (event.srcURL && event.mediaType === "image") {
      template.push(
        { label: "Open Image Externally", command: "web-browser:context-open-image-external" },
        { type: "separator" },
      );
    }
    if (event.isEditable) {
      template.push(
        { label: "Cut", command: "web-browser:context-cut" },
        { label: "Copy", command: "web-browser:context-copy" },
        { label: "Paste", command: "web-browser:context-paste" },
        { label: "Select All", command: "web-browser:context-select-all" },
        { type: "separator" },
      );
    } else if (event.selectionText) {
      template.push({ label: "Copy", command: "web-browser:context-copy" }, { type: "separator" });
    }
    template.push(
      { label: "Back", command: "web-browser:context-back" },
      { label: "Forward", command: "web-browser:context-forward" },
      { label: "Reload", command: "web-browser:context-reload" },
      { type: "separator" },
      { label: "Inspect", command: "web-browser:context-inspect" },
    );
    lumine.contextMenu.show(item.view.nativeHost, template, {
      anchor: { clientX: event.x, clientY: event.y },
    });
  },

  replyContext(item, action) {
    const event = item?.pendingContextMenu;
    if (!event) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, { action, x: event.x, y: event.y });
  },

  openContextLink(item) {
    const event = item?.pendingContextMenu;
    if (!event?.linkURL) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, null);
    return this.open(event.linkURL, { storageScope: item.storageScope });
  },

  openContextLinkExternal(item) {
    const event = item?.pendingContextMenu;
    if (!event?.linkURL) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, null);
    return lumine.shell.openExternal(event.linkURL);
  },

  openContextImageExternal(item) {
    const event = item?.pendingContextMenu;
    if (!event?.srcURL) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, null);
    return lumine.shell.openExternal(event.srcURL);
  },

  replaceContextSpelling(item, index) {
    const event = item?.pendingContextMenu;
    const word = event?.dictionarySuggestions?.[index];
    if (!event || !word) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, {
      action: "replaceMisspelling",
      word,
    });
  },

  addContextWord(item) {
    const event = item?.pendingContextMenu;
    if (!event?.misspelledWord || !item.getProfile().persistent) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, {
      action: "addWordToDictionary",
      word: event.misspelledWord,
    });
  },

  showPageMenu(item, anchor) {
    lumine.contextMenu.show(
      anchor,
      [
        { label: "Reload Without Cache", command: "web-browser:reload-ignoring-cache" },
        { label: "Print…", command: "web-browser:print" },
        { label: "Open Externally", command: "web-browser:open-external" },
        { type: "separator" },
        { label: "History…", command: "web-browser:show-history" },
        { label: "Site Permissions…", command: "web-browser:show-site-permissions" },
        { label: "Clear Browsing Data…", command: "web-browser:clear-browsing-data" },
      ],
      { anchor },
    );
  },

  async showSitePermissions(item) {
    let origin;
    try {
      origin = new URL(item.url).origin;
    } catch {
      return;
    }
    const entries = await this.dataStore.permissions(item.getProfile(), origin);
    if (!entries.length) {
      lumine.notifications.addInfo("This site has no saved permissions.");
      return;
    }
    return this.showList({
      items: entries,
      emptyMessage: "This site has no saved permissions",
      getId: (entry) => entry.id,
      label: (entry) => `${entry.permission}: ${entry.decision}`,
      detail: () => origin,
      onConfirm: async (entry) => {
        await this.dataStore.removePermission(item.getProfile(), origin, entry.permission);
        await item.surface?.setPermissionDecision?.(origin, entry.permission, null);
        lumine.notifications.addSuccess(`Reset ${entry.permission}`);
      },
    });
  },

  async clearBrowsingData(item) {
    const notification = lumine.notifications.addWarning("Clear browsing data for this profile?", {
      detail: "Cookies, cache, local storage, history, and saved site permissions will be removed.",
      dismissable: true,
      buttons: [
        {
          text: "Clear",
          className: "btn-primary",
          onDidClick: async () => {
            notification.dismiss();
            await item.surface?.clearBrowsingData({
              dataTypes: [
                "backgroundFetch",
                "cache",
                "cookies",
                "downloads",
                "fileSystems",
                "indexedDB",
                "localStorage",
                "serviceWorkers",
                "webSQL",
              ],
            });
            await this.dataStore.clearHistory(item.getProfile());
            await this.dataStore.clearPermissions(item.getProfile());
            for (const candidate of this.items) {
              if (candidate.getProfile().id === item.getProfile().id) candidate.surface?.reload();
            }
            lumine.notifications.addSuccess("Browsing data cleared");
          },
        },
        { text: "Cancel", onDidClick: () => notification.dismiss() },
      ],
    });
  },
};

module.exports = WebBrowserPackage;
