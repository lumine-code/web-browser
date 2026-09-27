const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");
const { CompositeDisposable, Disposable } = require("lumine");
const { WebBrowserItem } = require("./browser-item");
const WebBrowserView = require("./browser-view");
const { BrowserSurface } = require("./surface");
const { BrowserDataStore } = require("./data-store");
const { canPersistSiteDecision, normalizeStorageScope, workspaceKey } = require("./profiles");
const {
  isLocalWebURL,
  parseAddressInput,
  safeSuggestedFilename,
  webDocumentPath,
} = require("./url-parser");

function isBrowserItem(item) {
  return item instanceof WebBrowserItem;
}

function permissionLabel(event = {}) {
  if (event.permission === "media" && event.details?.mediaTypes?.length) {
    return event.details.mediaTypes
      .map((type) => ({ audio: "microphone", video: "camera" })[type] || type)
      .join(" and ");
  }
  return String(event.permission || "site capability").replaceAll("-", " ");
}

function profileFromURIQuery(query = {}) {
  const id = query.profileId;
  if (query.profilePersistent !== "true" || typeof id !== "string") return undefined;
  const storageScope = normalizeStorageScope(query.storageScope);
  const expectedScope = storageScope === "default" ? "global" : storageScope;
  if (expectedScope === "global" && id === "web-browser/global") {
    return { id, persistent: true, scope: "global" };
  }
  if (expectedScope === "workspace" && /^web-browser\/workspace\/[0-9a-f]{24}$/.test(id)) {
    return { id, persistent: true, scope: "workspace" };
  }
  return undefined;
}

const WebBrowserPackage = {
  items: new Set(),
  subscriptions: null,
  dataStore: null,
  treeView: null,
  lastBrowserItem: null,
  lastNonBrowserItem: null,
  downloads: new Map(),
  deviceRequests: new Map(),
  recentRevocations: new Set(),
  pendingByItem: new Map(),
  transientUI: new Set(),

  ensureState() {
    this.items ||= new Set();
    this.downloads ||= new Map();
    this.deviceRequests ||= new Map();
    this.recentRevocations ||= new Set();
    this.pendingByItem ||= new Map();
    this.transientUI ||= new Set();
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
      }),
      this.dataStore.onDidChange((change) => this.handleDataChange(change)),
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
    const items = [...this.items];
    const closures = [];
    for (const item of items) {
      const pane = lumine.workspace.paneForItem(item);
      if (pane) closures.push(pane.destroyItem(item, true));
      else closures.push(item.destroy());
    }
    await Promise.allSettled(closures);
    await Promise.allSettled(items.map((item) => item.destroy()));
    for (const ui of this.transientUI) {
      try {
        if (typeof ui.dismiss === "function") ui.dismiss();
        else ui.destroy?.();
      } catch {}
    }
    this.transientUI.clear();
    this.subscriptions?.dispose();
    this.subscriptions = null;
    this.items.clear();
    this.dataStore?.close();
    this.dataStore = null;
    this.treeView = null;
    this.downloads.clear();
    this.deviceRequests.clear();
    this.recentRevocations.clear();
    this.pendingByItem.clear();
  },

  trackUI(ui) {
    if (!ui) return ui;
    this.transientUI.add(ui);
    const forget = () => this.transientUI.delete(ui);
    ui.onDidDismiss?.(forget);
    ui.onDidDestroy?.(forget);
    return ui;
  },

  closeUI(ui) {
    if (!ui) return;
    this.transientUI.delete(ui);
    try {
      if (typeof ui.dismiss === "function") ui.dismiss();
      else ui.destroy?.();
    } catch {}
  },

  beginItemRequest(item, cancel, requestId = null) {
    let requests = this.pendingByItem.get(item);
    if (!requests) this.pendingByItem.set(item, (requests = new Set()));
    const record = {
      active: true,
      requestId,
      ui: null,
      setUI: (ui) => {
        record.ui = ui;
        if (ui && !this.transientUI.has(ui)) this.trackUI(ui);
        if (!record.active) this.closeUI(ui);
        return ui;
      },
      finish: (action, { closeUI = true } = {}) => {
        if (!record.active) return false;
        record.active = false;
        requests.delete(record);
        if (requests.size === 0) this.pendingByItem.delete(item);
        try {
          const result = action?.();
          Promise.resolve(result).catch(() => {});
        } catch {}
        if (closeUI) this.closeUI(record.ui);
        return true;
      },
    };
    record.cancel = () => record.finish(cancel);
    requests.add(record);
    return record;
  },

  safeSurfaceResponse(item, type, requestId, response) {
    try {
      const result = item.surface?.respond(type, requestId, response);
      Promise.resolve(result).catch(() => {});
      return result;
    } catch {
      return undefined;
    }
  },

  cleanupItemRequests(item) {
    for (const request of [...(this.pendingByItem.get(item) || [])]) request.cancel();
    this.pendingByItem.delete(item);
    for (const [key, download] of this.downloads) {
      if (download.item !== item) continue;
      download.pending?.cancel();
      this.downloads.delete(key);
    }
    for (const [key, request] of this.deviceRequests) {
      if (request.item !== item) continue;
      request.pending.cancel();
      this.deviceRequests.delete(key);
    }
  },

  downloadKey(item, requestId) {
    return `${item.id}:${requestId}`;
  },

  deviceRequestKey(item, requestId) {
    return `${item.id}:${requestId}`;
  },

  deserialize(state) {
    this.ensureState();
    return WebBrowserItem.deserialize(state, this);
  },

  handleURI(parsedURI) {
    const raw = parsedURI?.query?.url;
    const scope = parsedURI?.query?.storageScope;
    const profile = profileFromURIQuery(parsedURI?.query);
    if (typeof raw === "string") void this.open(raw, { storageScope: scope, profile });
    else void this.open("", { storageScope: scope, profile });
  },

  openURI(uri) {
    if (typeof uri !== "string") return undefined;
    const storageScope = lumine.config.get("web-browser.dataStorage");
    if (/^https?:\/\//i.test(uri)) {
      return new WebBrowserItem({ package: this, url: uri, storageScope });
    }
    if (/^file:\/\//i.test(uri)) {
      try {
        const filePath = fileURLToPath(uri);
        if (!webDocumentPath(filePath)) return undefined;
        return new WebBrowserItem({
          package: this,
          url: uri,
          storageScope,
          filePath,
          autoReload: lumine.config.get("web-browser.autoReloadOnFileChange"),
        });
      } catch {
        return undefined;
      }
    }
    return undefined;
  },

  async open(url = "", options = {}) {
    this.ensureState();
    if (url) {
      const parsed = parseAddressInput(url, {
        searchEngine: lumine.config.get("web-browser.searchEngine"),
        resolvePath: (candidate) => this.resolveAddressPath(candidate),
      });
      if (!parsed.url || parsed.kind === "invalid") throw new Error(parsed.reason || "Invalid URL");
      url = parsed.url === "about:blank" ? "" : parsed.url;
    }
    const item = new WebBrowserItem({
      package: this,
      url,
      storageScope: options.storageScope || lumine.config.get("web-browser.dataStorage"),
      profile: options.profile,
      projectPaths: options.projectPaths,
      autoReload: options.autoReload,
      filePath: options.filePath,
    });
    const placement = options.placement || lumine.config.get("web-browser.newTabPlacement");
    if (placement === "window") {
      const profile = item.getProfile();
      const query = new URLSearchParams({
        url,
        storageScope: item.storageScope,
        ...(profile.persistent ? { profileId: profile.id, profilePersistent: "true" } : {}),
      });
      lumine.application.openWindow({
        newWindow: true,
        locationsToOpen: item.projectPaths.map((pathToOpen) => ({
          pathToOpen,
          isDirectory: true,
        })),
        urlsToOpen: [`lumine://web-browser/open?${query}`],
        devMode: lumine.devMode,
        safeMode: lumine.safeMode,
      });
      await item.destroy();
      return null;
    }
    const openOptions = {
      activateItem: options.activate !== false,
      ...(placement === "side-pane" ? { split: "right" } : {}),
    };
    await lumine.workspace.open(item, openOptions);
    this.lastBrowserItem = item;
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

  handleDataChange(change = {}) {
    if (change.kind === "favorites") {
      const currentWorkspace = workspaceKey(lumine.project.getPaths());
      if (!change.workspaceId || change.workspaceId === currentWorkspace) {
        for (const item of this.items) void this.syncFavorite(item);
      }
      return;
    }
    if (change.kind === "permissions" && change.profileId) {
      for (const item of this.items) {
        if (item.getProfile().id !== change.profileId || !item.surface) continue;
        if (typeof change.permission === "string" && typeof change.origin === "string") {
          const allow =
            change.decision === "allow" ? true : change.decision === "block" ? false : null;
          void Promise.resolve(
            item.surface.setPermissionDecision(change.origin, change.permission, allow),
          ).catch(() => {});
        } else {
          void Promise.resolve(item.surface.clearBrowsingData({ permissions: true }))
            .then(() => this.hydratePermissionDecisions(item))
            .catch(() => {});
        }
      }
    }
  },

  cleanUserAgent() {
    return String(globalThis.window?.navigator?.userAgent || "")
      .replace(/\sElectron\/[^\s]+/gi, "")
      .replace(/\sLumine\/[^\s]+/gi, "")
      .trim();
  },

  resolveAddressPath(candidate) {
    if (path.isAbsolute(candidate)) return path.normalize(candidate);
    const active = lumine.workspace.getActivePaneItem();
    const documentPath = active?.getPath?.() || this.lastNonBrowserItem?.getPath?.();
    const bases = [
      ...(documentPath ? [path.dirname(documentPath)] : []),
      ...lumine.project.getPaths(),
      process.cwd(),
    ];
    for (const base of bases) {
      const resolved = path.resolve(base, candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
    return path.resolve(bases[0] || process.cwd(), candidate);
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
      "web-browser:clear-history": {
        description: "Forget every page in the current browser profile's history.",
        didDispatch: () => this.clearHistory(),
      },
      "web-browser:open-external": withItem("Open Externally", (item) => this.openExternal(item)),
      "web-browser:open-in-new-window": withItem("Open in New Window", (item) =>
        this.open(item.url, {
          placement: "window",
          storageScope: item.storageScope,
          profile: item.getProfile().persistent ? item.getProfile() : undefined,
          projectPaths: item.projectPaths,
        }),
      ),
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
      "web-browser:context-print": reply("print"),
      "web-browser:context-copy": reply("copy"),
      "web-browser:context-cut": reply("cut"),
      "web-browser:context-paste": reply("paste"),
      "web-browser:context-undo": reply("undo"),
      "web-browser:context-redo": reply("redo"),
      "web-browser:context-select-all": reply("selectAll"),
      "web-browser:context-inspect": reply("inspect"),
      "web-browser:context-open-link": (event) => this.openContextLink(this.activeItem(event)),
      "web-browser:context-open-link-external": (event) =>
        this.openContextLinkExternal(this.activeItem(event)),
      "web-browser:context-open-image-external": (event) =>
        this.openContextImageExternal(this.activeItem(event)),
      "web-browser:context-open-image": (event) => this.openContextImage(this.activeItem(event)),
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
      if (this.lastNonBrowserItem && lumine.workspace.paneForItem(this.lastNonBrowserItem)) {
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
    const history = (
      await this.dataStore.history(profile, {
        query,
        limit: query ? 6 : 3,
        explicitOnly: !query,
      })
    ).map((entry) => ({
      label: entry.title,
      detail: entry.url,
      run: () => item.navigate(entry.url),
    }));
    const action = [];
    if (query) {
      const parsed = parseAddressInput(item.view?.addressInput.value || query, {
        searchEngine: lumine.config.get("web-browser.searchEngine"),
        resolvePath: (candidate) => this.resolveAddressPath(candidate),
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

  async syncFavorite(item) {
    if (!item.url) return item.view?.updateFavorite(false);
    const favorite = await this.dataStore.isFavorite(
      workspaceKey(lumine.project.getPaths()),
      item.url,
    );
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
      detail: (entry) => `${new Date(entry.timestamp).toLocaleString()} — ${entry.url}`,
      groupBy: (entry) => new Date(entry.timestamp).toLocaleDateString(),
      onConfirm: (entry) =>
        this.open(entry.url, {
          storageScope: item.storageScope,
          profile: profile.persistent ? profile : undefined,
          projectPaths: item.projectPaths,
        }),
      onRemove: (entry) => this.dataStore.removeHistory(entry.id, profile.id),
    });
  },

  clearHistory() {
    const item = this.activeItem() || this.lastBrowserItem;
    if (!item) return;
    let notification;
    notification = this.trackUI(
      lumine.notifications.addWarning("Clear browser history for this profile?", {
        dismissable: true,
        buttons: [
          {
            text: "Clear",
            className: "btn-primary",
            onDidClick: async () => {
              notification.dismiss();
              await this.dataStore.clearHistory(item.getProfile());
              lumine.notifications.addSuccess("Browser history cleared");
            },
          },
          { text: "Cancel", onDidClick: () => notification.dismiss() },
        ],
      }),
    );
  },

  showList({ items, emptyMessage, getId, label, detail, groupBy, onConfirm, onCancel, onRemove }) {
    let currentItems = [...items];
    const sections = () => {
      if (!groupBy) return null;
      const groups = new Map();
      for (const item of currentItems) {
        const id = String(groupBy(item));
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(item);
      }
      return [...groups].map(([id, sectionItems]) => ({ id, items: sectionItems }));
    };
    const host = lumine.workspace.addSelectList(
      {
        ...(groupBy ? { sections: sections() } : { items: currentItems }),
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
          "web-browser:remove-list-item": async ({ detail: eventDetail }) => {
            if (!onRemove) return;
            await onRemove(eventDetail.item);
            currentItems = currentItems.filter((item) => item !== eventDetail.item);
            if (groupBy) await host.getModel().setSections(sections());
            else await host.getModel().setItems(currentItems);
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
          ...(onRemove
            ? [
                {
                  command: "web-browser:remove-list-item",
                  context: "item",
                  group: "Manage",
                  disposition: "stay",
                  dispatch: "local",
                },
              ]
            : []),
        ],
      },
      { className: "web-browser-list" },
    );
    this.trackUI(host);
    host.onDidCancel(() => {
      onCancel?.();
      host.destroy();
    });
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
    if (item?.url) return this.openExternally(item.url);
  },

  openExternally(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") return lumine.shell.openPath(fileURLToPath(parsed));
      if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        return lumine.shell.openExternal(parsed.toString());
      }
    } catch {}
    return undefined;
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
      profile: parent.getProfile(),
      projectPaths: parent.projectPaths,
      surface,
    });
    const pane = lumine.workspace.paneForItem(parent);
    try {
      await (pane
        ? pane.addItem(item, { index: pane.getActiveItemIndex() + 1 })
        : lumine.workspace.open(item));
      const accepted = await parent.surface.respond("popup", event.requestId, { accept: true });
      if (accepted !== true) throw new Error("The popup request expired before it was adopted");
      if (item.destroyed) throw new Error("The popup closed before it was adopted");
      if (!/background/i.test(event.disposition || "")) pane?.activateItem(item);
    } catch (error) {
      try {
        await parent.surface?.respond("popup", event.requestId, { accept: false });
      } catch {}
      const itemPane = lumine.workspace.paneForItem(item);
      if (itemPane) await itemPane.destroyItem(item, true);
      else item.destroy();
      console.warn("Unable to adopt browser popup", error);
    }
  },

  handlePopupBlocked(_item, event = {}) {
    this.trackUI(
      lumine.notifications.addInfo("Popup blocked", {
        detail: event.url || "The page tried to open a window without a recent user action.",
        dismissable: true,
      }),
    );
  },

  handleSurfaceDestroyed(item) {
    if (!item || item.destroyed) return;
    const pane = lumine.workspace.paneForItem(item);
    if (pane) {
      void Promise.resolve(pane.destroyItem(item, true)).catch((error) =>
        console.error("Unable to close a destroyed browser tab", error),
      );
    } else {
      item.destroy();
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
    const notification = this.trackUI(
      lumine.notifications.addInfo("Open link in an external application?", {
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
      }),
    );
  },

  async handlePermission(item, event = {}) {
    const pending = this.beginItemRequest(
      item,
      () =>
        this.safeSurfaceResponse(item, "permission", event.requestId, {
          allow: false,
          remember: false,
        }),
      event.requestId,
    );
    const profile = item.getProfile();
    const canRemember =
      canPersistSiteDecision(profile) && /^https?:\/\//i.test(String(event.origin || ""));
    const permissionKeys =
      Array.isArray(event.permissionKeys) && event.permissionKeys.length > 0
        ? event.permissionKeys
        : [event.permission];
    const saved = await Promise.all(
      permissionKeys.map((permission) =>
        this.dataStore.permission(profile, event.origin, permission),
      ),
    );
    if (!pending.active) return;
    if (saved.every(Boolean)) {
      return pending.finish(() =>
        this.safeSurfaceResponse(item, "permission", event.requestId, {
          allow: saved.every((entry) => entry.decision === "allow"),
          remember: true,
        }),
      );
    }
    let notification;
    const settle = async (allow, remember = false) => {
      if (!pending.active) return;
      if (remember && canRemember) {
        await Promise.all(
          permissionKeys.map((permission) =>
            this.dataStore.setPermission(
              profile,
              event.origin,
              permission,
              allow ? "allow" : "block",
            ),
          ),
        );
      }
      if (!pending.active) return;
      pending.finish(() =>
        this.safeSurfaceResponse(item, "permission", event.requestId, { allow, remember }),
      );
    };
    const buttons = [
      { text: "Allow Once", className: "btn-primary", onDidClick: () => settle(true) },
      ...(canRemember ? [{ text: "Always Allow", onDidClick: () => settle(true, true) }] : []),
      { text: "Block", onDidClick: () => settle(false, canRemember) },
    ];
    notification = pending.setUI(
      lumine.notifications.addWarning(
        `${event.origin || "This site"} requests ${permissionLabel(event)}`,
        {
          detail: "Allow only sites you trust.",
          dismissable: true,
          buttons,
        },
      ),
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
    const key = this.deviceRequestKey(item, event.requestId);
    const forget = () => this.deviceRequests.delete(key);
    const pending = this.beginItemRequest(
      item,
      () => {
        forget();
        return this.safeSurfaceResponse(item, "device", event.requestId, { deviceId: null });
      },
      event.requestId,
    );
    const devices = event.devices || [];
    const list = this.showList({
      items: devices,
      emptyMessage: `No ${event.deviceType || "matching"} devices are available for ${event.origin || "this site"}`,
      getId: (device) => device.deviceId,
      label: (device) => `${device.name || "Unnamed device"} (${event.deviceType || "device"})`,
      detail: (device) =>
        `${event.origin || "Unknown origin"}${
          device.vendorId != null || device.productId != null
            ? ` — ${[device.vendorId, device.productId].filter((value) => value != null).join(":")}`
            : ""
        }`,
      onConfirm: async (device) => {
        const profile = item.getProfile();
        if (
          canPersistSiteDecision(profile) &&
          /^https?:\/\//i.test(event.origin || "") &&
          ["hid", "serial", "usb"].includes(event.deviceType)
        ) {
          try {
            await this.dataStore.setPermission(
              profile,
              event.origin,
              `device:${event.deviceType}:${device.deviceId}`,
              "allow",
            );
          } catch (error) {
            lumine.notifications.addWarning("Device access will last only for this session", {
              detail: error.message,
              dismissable: true,
            });
          }
        }
        forget();
        return pending.finish(() =>
          this.safeSurfaceResponse(item, "device", event.requestId, {
            deviceId: device.deviceId,
          }),
        );
      },
      onCancel: () => {
        forget();
        pending.cancel();
      },
    });
    pending.setUI(list);
    this.deviceRequests.set(key, { item, pending, list });
  },

  handleDeviceUpdate(item, event = {}) {
    const request = this.deviceRequests.get(this.deviceRequestKey(item, event.requestId));
    if (!request?.pending.active) return;
    void request.list.getModel().setItems(event.devices || []);
  },

  async handleDeviceRevoked(item, event = {}) {
    const profile = item.getProfile();
    if (!profile.persistent || !event.permission) return;
    try {
      if (event.origin && event.origin !== "null") {
        await this.dataStore.removePermission(profile, event.origin, event.permission);
      } else {
        const entries = await this.dataStore.permissions(profile);
        await Promise.all(
          entries
            .filter((entry) => entry.permission === event.permission)
            .map((entry) =>
              this.dataStore.removePermission(profile, entry.origin, entry.permission),
            ),
        );
      }
    } catch (error) {
      lumine.notifications.addWarning("Unable to forget the revoked device", {
        detail: error.message,
        dismissable: true,
      });
      return;
    }
    const noticeKey = `${profile.id}\0${event.origin}\0${event.permission}`;
    if (!this.recentRevocations.has(noticeKey)) {
      this.recentRevocations.add(noticeKey);
      setTimeout(() => this.recentRevocations.delete(noticeKey), 1000);
      lumine.notifications.addInfo("Device permission revoked", {
        detail: `${event.deviceType || "Device"} access was removed by the page.`,
        dismissable: true,
      });
    }
  },

  handleRequestExpired(item, event = {}) {
    for (const request of [...(this.pendingByItem.get(item) || [])]) {
      if (request.requestId === event.requestId) request.cancel();
    }
    if (item.pendingContextMenu?.requestId === event.requestId) {
      item.pendingContextMenu = null;
    }
    this.trackUI(
      lumine.notifications.addInfo("Browser request expired", {
        detail: `${event.type || "The request"} was denied because it received no response.`,
        dismissable: true,
      }),
    );
  },

  handleAuthentication(item, event = {}) {
    const pending = this.beginItemRequest(
      item,
      () => this.safeSurfaceResponse(item, "authentication", event.requestId, null),
      event.requestId,
    );
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
    const panel = pending.setUI(
      lumine.workspace.addModalPanel({ item: form, autoFocus: username }),
    );
    const finish = (response) => {
      pending.finish(() =>
        this.safeSurfaceResponse(item, "authentication", event.requestId, response),
      );
    };
    form.addEventListener("submit", (submitEvent) => {
      submitEvent.preventDefault();
      finish({ username: username.value, password: password.value });
    });
    cancel.addEventListener("click", () => finish(null));
    panel.onDidChangeVisible((visible) => {
      if (!visible) finish(null);
    });
    panel.onDidDestroy(() => finish(null));
  },

  async handleDownload(item, event = {}) {
    const choice = this.beginItemRequest(
      item,
      () => this.safeSurfaceResponse(item, "download", event.requestId, null),
      event.requestId,
    );
    const filename = safeSuggestedFilename(event.filename);
    const result = await lumine.window.showSaveDialog({
      title: "Save Download",
      defaultPath: path.join(lumine.application.getPath("downloads"), filename),
    });
    if (!choice.active) return;
    const filePath = result?.filePath;
    if (!filePath) {
      return choice.finish(() => this.safeSurfaceResponse(item, "download", event.requestId, null));
    }
    const key = this.downloadKey(item, event.requestId);
    const pending = this.beginItemRequest(item, () => {
      this.downloads.delete(key);
      try {
        const result = item.surface?.cancelDownload(event.requestId);
        Promise.resolve(result).catch(() => {});
      } catch {}
    });
    const notification = pending.setUI(
      lumine.notifications.addInfo(`Downloading ${filename}`, {
        detail: filePath,
        dismissable: true,
        buttons: [
          {
            text: "Cancel",
            onDidClick: () => pending.cancel(),
          },
        ],
      }),
    );
    const download = { item, notification, filePath, filename, pending };
    this.downloads.set(key, download);
    let responseResult;
    choice.finish(() => {
      responseResult = this.safeSurfaceResponse(item, "download", event.requestId, {
        path: filePath,
      });
    });
    void Promise.resolve(responseResult).then(
      (accepted) => {
        if (accepted !== true) pending.cancel();
      },
      () => pending.cancel(),
    );
  },

  handleDownloadUpdate(item, event = {}) {
    const download = this.downloads.get(this.downloadKey(item, event.requestId));
    if (!download) return;
    const percent =
      event.totalBytes > 0 ? Math.round((event.receivedBytes / event.totalBytes) * 100) : null;
    download.notification.setDetail?.(
      `${download.filePath}${percent == null ? "" : ` — ${percent}%`}`,
    );
  },

  handleDownloadFinish(item, event = {}) {
    const key = this.downloadKey(item, event.requestId);
    const download = this.downloads.get(key);
    if (!download) return;
    this.downloads.delete(key);
    download.pending.finish();
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
      if (item.getProfile().persistent) {
        template.push({
          label: "Add to Dictionary",
          command: "web-browser:context-add-dictionary",
        });
      }
      template.push({ type: "separator" });
    }
    if (event.linkURL) {
      const linkActions = [];
      if (/^(?:https?|file):/i.test(event.linkURL)) {
        linkActions.push({
          label: "Open Link in New Tab",
          command: "web-browser:context-open-link",
        });
      }
      if (/^(?:https?|mailto):/i.test(event.linkURL)) {
        linkActions.push({
          label: "Open Link Externally",
          command: "web-browser:context-open-link-external",
        });
      }
      if (linkActions.length) template.push(...linkActions, { type: "separator" });
    }
    if (/^(?:https?|file):/i.test(event.srcURL || "") && event.mediaType === "image") {
      template.push(
        { label: "Open Image in New Tab", command: "web-browser:context-open-image" },
        { label: "Open Image Externally", command: "web-browser:context-open-image-external" },
        { type: "separator" },
      );
    }
    const editFlags = event.editFlags || {};
    if (event.isEditable) {
      template.push(
        { label: "Undo", command: "web-browser:context-undo", enabled: editFlags.canUndo === true },
        { label: "Redo", command: "web-browser:context-redo", enabled: editFlags.canRedo === true },
        { type: "separator" },
        { label: "Cut", command: "web-browser:context-cut", enabled: editFlags.canCut === true },
        { label: "Copy", command: "web-browser:context-copy", enabled: editFlags.canCopy === true },
        {
          label: "Paste",
          command: "web-browser:context-paste",
          enabled: editFlags.canPaste === true,
        },
        {
          label: "Select All",
          command: "web-browser:context-select-all",
          enabled: editFlags.canSelectAll === true,
        },
        { type: "separator" },
      );
    } else if (event.selectionText) {
      template.push(
        {
          label: "Copy",
          command: "web-browser:context-copy",
          enabled: editFlags.canCopy === true,
        },
        { type: "separator" },
      );
    }
    template.push(
      { label: "Back", command: "web-browser:context-back" },
      { label: "Forward", command: "web-browser:context-forward" },
      { label: "Reload", command: "web-browser:context-reload" },
      { type: "separator" },
      { label: "Print…", command: "web-browser:context-print" },
      { label: "Inspect", command: "web-browser:context-inspect" },
    );
    const bounds = item.view.nativeHost.getBoundingClientRect();
    const menu = lumine.contextMenu.show(item.view.nativeHost, template, {
      anchor: { clientX: bounds.left + event.x, clientY: bounds.top + event.y },
    });
    menu?.onDidClose?.(() => {
      if (item.pendingContextMenu !== event) return;
      item.pendingContextMenu = null;
      item.surface.respond("context-menu", event.requestId, null);
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
    return this.open(event.linkURL, {
      storageScope: item.storageScope,
      profile: item.getProfile().persistent ? item.getProfile() : undefined,
      projectPaths: item.projectPaths,
    });
  },

  openContextLinkExternal(item) {
    const event = item?.pendingContextMenu;
    if (!event?.linkURL) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, null);
    return this.openExternally(event.linkURL);
  },

  openContextImageExternal(item) {
    const event = item?.pendingContextMenu;
    if (!event?.srcURL) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, null);
    return this.openExternally(event.srcURL);
  },

  openContextImage(item) {
    const event = item?.pendingContextMenu;
    if (!event?.srcURL) return;
    item.pendingContextMenu = null;
    item.surface.respond("context-menu", event.requestId, null);
    return this.open(event.srcURL, {
      storageScope: item.storageScope,
      profile: item.getProfile().persistent ? item.getProfile() : undefined,
      projectPaths: item.projectPaths,
    });
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
        { label: "Open in New Window", command: "web-browser:open-in-new-window" },
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

  clearBrowsingData(item) {
    const pending = this.beginItemRequest(item, () => {});
    const form = document.createElement("form");
    form.className = "web-browser-clear-dialog padded";
    const heading = document.createElement("h2");
    heading.textContent = "Clear Browsing Data";
    const description = document.createElement("p");
    description.textContent = "Choose the data to remove from this browser profile.";
    const checkbox = (label, checked = true) => {
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      row.append(input, document.createTextNode(label));
      form.appendChild(row);
      return input;
    };
    form.append(heading, description);
    const siteData = checkbox("Cookies, cache, and site storage");
    const history = checkbox("Browsing history");
    const permissions = checkbox("Saved site and device permissions");
    const actions = document.createElement("div");
    actions.className = "web-browser-dialog-actions";
    const clear = document.createElement("button");
    clear.type = "submit";
    clear.className = "btn btn-primary";
    clear.textContent = "Clear";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    actions.append(clear, cancel);
    form.appendChild(actions);

    const panel = pending.setUI(lumine.workspace.addModalPanel({ item: form, autoFocus: clear }));
    cancel.addEventListener("click", () => pending.cancel());
    panel.onDidDestroy(() => pending.cancel());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!pending.active) return;
      if (!siteData.checked && !history.checked && !permissions.checked) {
        lumine.notifications.addWarning("Select at least one kind of browsing data.");
        return;
      }
      clear.disabled = true;
      const profile = item.getProfile();
      try {
        if (permissions.checked) {
          for (const entry of await this.dataStore.permissions(profile)) {
            await item.surface?.setPermissionDecision?.(entry.origin, entry.permission, null);
          }
        }
        if (siteData.checked || permissions.checked) {
          await item.surface?.clearBrowsingData({
            permissions: permissions.checked,
            ...(siteData.checked
              ? {
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
                }
              : {}),
          });
        }
        if (history.checked) await this.dataStore.clearHistory(profile);
        if (permissions.checked) await this.dataStore.clearPermissions(profile);
        if (siteData.checked) {
          for (const candidate of this.items) {
            if (candidate.getProfile().id === profile.id) candidate.surface?.reload();
          }
        }
        pending.finish();
        lumine.notifications.addSuccess("Selected browsing data cleared");
      } catch (error) {
        clear.disabled = false;
        lumine.notifications.addError("Unable to clear browsing data", {
          detail: error.message,
          dismissable: true,
        });
      }
    });
    return panel;
  },
};

module.exports = WebBrowserPackage;
