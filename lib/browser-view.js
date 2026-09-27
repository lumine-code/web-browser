const { CompositeDisposable } = require("lumine");
const { DEVICE_PRESETS, SCALES, normalizeEmulation } = require("./device-emulation");
const { parseAddressInput } = require("./url-parser");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, label, icon) {
  const node = element("button", `btn ${className}`);
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  if (icon) node.appendChild(element("span", `icon icon-${icon}`));
  return node;
}

class WebBrowserView {
  constructor(item) {
    this.item = item;
    this.package = item.package;
    this.subscriptions = new CompositeDisposable();
    this.domDisposables = [];
    this.surface = null;
    this.overlayDisposable = null;
    this.screenshotTimer = null;
    this.pickerRequest = 0;
    this.destroyed = false;
    this.build();
    this.item.setView(this);
    void this.initialize();
  }

  build() {
    this.element = element("div", "web-browser native-key-bindings");
    this.element.tabIndex = -1;
    this.element.webBrowserItem = this.item;

    this.toolbar = element("div", "web-browser-toolbar");
    this.backButton = button("web-browser-back", "Back", "arrow-left");
    this.forwardButton = button("web-browser-forward", "Forward", "arrow-right");
    this.reloadButton = button("web-browser-reload", "Reload", "sync");
    this.homeButton = button("web-browser-new-tab", "New Tab", "plus");
    this.toolbar.append(this.backButton, this.forwardButton, this.reloadButton, this.homeButton);

    this.addressBox = element("div", "web-browser-address-box");
    this.addressInput = element("input", "input-text native-key-bindings web-browser-address");
    this.addressInput.type = "text";
    this.addressInput.spellcheck = false;
    this.addressInput.placeholder = "Search or enter address";
    this.addressInput.setAttribute("aria-label", "Address");
    this.favoriteButton = button("web-browser-favorite", "Add or Remove Favorite", "star");
    this.addressBox.append(this.addressInput, this.favoriteButton);
    this.picker = element("div", "web-browser-address-picker");
    this.picker.hidden = true;
    this.picker.setAttribute("role", "listbox");
    this.addressBox.appendChild(this.picker);
    this.toolbar.appendChild(this.addressBox);

    this.findButton = button("web-browser-find", "Find in Page", "search");
    this.responsiveButton = button("web-browser-responsive", "Responsive Mode", "device-mobile");
    this.externalButton = button("web-browser-external", "Open Externally", "link-external");
    this.devtoolsButton = button("web-browser-devtools", "Open DevTools", "terminal");
    this.menuButton = button("web-browser-menu", "More Actions", "ellipsis");
    this.toolbar.append(
      this.findButton,
      this.responsiveButton,
      this.externalButton,
      this.devtoolsButton,
      this.menuButton,
    );

    this.findBar = element("div", "web-browser-find-bar");
    this.findBar.hidden = true;
    this.findInput = element("input", "input-text native-key-bindings web-browser-find-input");
    this.findInput.type = "search";
    this.findInput.placeholder = "Find in page";
    this.findResult = element("span", "web-browser-find-result", "0/0");
    this.findPrevious = button("web-browser-find-previous", "Previous Match", "arrow-up");
    this.findNext = button("web-browser-find-next", "Next Match", "arrow-down");
    this.findClose = button("web-browser-find-close", "Close Find", "x");
    this.findBar.append(
      this.findInput,
      this.findResult,
      this.findPrevious,
      this.findNext,
      this.findClose,
    );

    this.emulationBar = this.buildEmulationBar();
    this.emulationBar.hidden = true;

    this.content = element("div", "web-browser-content");
    this.placeholder = element("div", "web-browser-placeholder");
    this.placeholderMessage = element("div", "web-browser-placeholder-message", "New Tab");
    this.placeholder.appendChild(this.placeholderMessage);
    this.nativeHost = element("div", "web-browser-native-host native-key-bindings");
    this.nativeHost.tabIndex = -1;
    this.error = element("div", "web-browser-error");
    this.error.hidden = true;
    this.errorTitle = element("h2", null, "Page could not be loaded");
    this.errorDetail = element("p");
    this.retryButton = button("web-browser-retry", "Retry", "sync");
    this.error.append(this.errorTitle, this.errorDetail, this.retryButton);
    this.hoverURL = element("div", "web-browser-hover-url");
    this.hoverURL.hidden = true;
    this.content.append(this.placeholder, this.nativeHost, this.error, this.hoverURL);
    this.element.append(this.toolbar, this.findBar, this.emulationBar, this.content);

    this.bindDOM();
    this.renderState(this.item.lastSurfaceState);
  }

  buildEmulationBar() {
    const bar = element("div", "web-browser-emulation-bar");
    this.deviceSelect = element("select", "input-select native-key-bindings");
    this.deviceSelect.appendChild(new Option("Responsive", "responsive"));
    for (const name of Object.keys(DEVICE_PRESETS))
      this.deviceSelect.appendChild(new Option(name, name));
    this.widthInput = element("input", "input-text native-key-bindings web-browser-dimension");
    this.widthInput.type = "number";
    this.widthInput.min = "200";
    this.widthInput.max = "9999";
    this.widthInput.value = "1280";
    this.heightInput = this.widthInput.cloneNode();
    this.heightInput.value = "720";
    this.dprInput = this.widthInput.cloneNode();
    this.dprInput.min = "0.5";
    this.dprInput.max = "5";
    this.dprInput.step = "0.25";
    this.dprInput.value = "1";
    this.scaleSelect = element("select", "input-select native-key-bindings");
    for (const scale of SCALES) {
      this.scaleSelect.appendChild(
        new Option(scale === "auto" ? "Auto" : `${scale * 100}%`, String(scale)),
      );
    }
    this.rotateButton = button("web-browser-rotate", "Swap Dimensions", "arrow-swap");
    this.mobileButton = button("web-browser-mobile", "Toggle Mobile and Touch", "device-mobile");
    this.emulationClose = button("web-browser-emulation-close", "Close Responsive Mode", "x");
    bar.append(
      element("span", null, "Device"),
      this.deviceSelect,
      element("span", null, "Width"),
      this.widthInput,
      element("span", null, "Height"),
      this.heightInput,
      element("span", null, "DPR"),
      this.dprInput,
      element("span", null, "Scale"),
      this.scaleSelect,
      this.rotateButton,
      this.mobileButton,
      this.emulationClose,
    );
    return bar;
  }

  bindDOM() {
    const listen = (target, name, callback, options) => {
      target.addEventListener(name, callback, options);
      this.domDisposables.push(() => target.removeEventListener(name, callback, options));
    };
    listen(this.backButton, "click", () => this.surface?.goBack());
    listen(this.forwardButton, "click", () => this.surface?.goForward());
    listen(this.reloadButton, "click", () => this.package.reload(this.item));
    listen(this.homeButton, "click", () => this.package.open());
    listen(this.favoriteButton, "click", () => this.package.toggleFavorite(this.item));
    listen(this.findButton, "click", () => this.showFind());
    listen(this.responsiveButton, "click", () => this.toggleResponsive());
    listen(this.externalButton, "click", () => this.package.openExternal(this.item));
    listen(this.devtoolsButton, "click", () => this.surface?.openDevTools());
    listen(this.menuButton, "click", () => this.package.showPageMenu(this.item, this.menuButton));
    listen(this.retryButton, "click", () => this.surface?.reload());
    listen(this.addressInput, "focus", () => void this.showPicker());
    listen(this.addressInput, "input", () => void this.showPicker());
    listen(this.addressInput, "keydown", (event) => this.addressKeydown(event));
    listen(this.findInput, "input", () => this.find(true));
    listen(this.findInput, "keydown", (event) => {
      if (event.key === "Enter") this.find(!event.shiftKey);
      if (event.key === "Escape") this.hideFind();
    });
    listen(this.findPrevious, "click", () => this.find(false));
    listen(this.findNext, "click", () => this.find(true));
    listen(this.findClose, "click", () => this.hideFind());
    listen(this.deviceSelect, "change", () => this.applyEmulation());
    for (const input of [this.widthInput, this.heightInput, this.dprInput, this.scaleSelect]) {
      listen(input, "change", () => this.applyEmulation());
    }
    listen(this.rotateButton, "click", () => {
      [this.widthInput.value, this.heightInput.value] = [
        this.heightInput.value,
        this.widthInput.value,
      ];
      this.applyEmulation();
    });
    listen(this.mobileButton, "click", () => {
      this.mobileButton.classList.toggle("selected");
      this.applyEmulation();
    });
    listen(this.emulationClose, "click", () => this.toggleResponsive(false));
    listen(this.nativeHost, "focus", () => this.surface?.focus());
    listen(this.element, "focus", (event) => {
      if (event.target !== this.element) return;
      if (this.item.url) this.nativeHost.focus();
      else this.focusAddress();
    });
    listen(document, "mousedown", (event) => {
      if (!this.addressBox.contains(event.target)) this.hidePicker();
    });
  }

  async initialize() {
    try {
      this.surface = await this.item.ensureSurface();
      if (this.destroyed) return;
      this.surface.attach(this.nativeHost);
      this.overlayDisposable = this.surface.registerOverlay(this.picker);
      if (this.item.url) await this.surface.loadURL(this.item.url);
      else {
        this.addressInput.focus();
        await this.showPicker();
      }
      this.startScreenshots();
    } catch (error) {
      console.error("Unable to initialize Web Browser surface", error);
      this.showError(error);
    }
  }

  addressKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      void this.navigateAddress(this.addressInput.value);
    } else if (event.key === "Escape") {
      if (!this.picker.hidden) this.hidePicker();
      else void this.surface?.focus();
    }
  }

  async navigateAddress(value) {
    const parsed = parseAddressInput(value, {
      searchEngine: lumine.config.get("web-browser.searchEngine"),
    });
    if (!parsed.url || parsed.kind === "invalid") {
      lumine.notifications.addWarning("Unable to open address", {
        detail: parsed.reason || "Enter a URL or search query.",
        dismissable: true,
      });
      return;
    }
    this.hidePicker();
    await this.item.navigate(parsed.url, { explicit: true });
    await this.surface?.focus();
  }

  async showPicker() {
    const request = ++this.pickerRequest;
    const query = this.addressInput.value.trim().toLowerCase();
    const groups = await this.package.addressSuggestions(this.item, query);
    if (this.destroyed || request !== this.pickerRequest) return;
    this.picker.textContent = "";
    for (const group of groups) {
      if (!group.items.length) continue;
      this.picker.appendChild(element("div", "web-browser-picker-heading", group.label));
      for (const entry of group.items) {
        const row = element("button", "web-browser-picker-item");
        row.type = "button";
        row.setAttribute("role", "option");
        row.append(
          element("span", "icon " + (entry.icon || "icon-globe")),
          element("span", "web-browser-picker-primary", entry.label),
          element("span", "web-browser-picker-secondary", entry.detail || ""),
        );
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => {
          this.hidePicker();
          void entry.run();
        });
        this.picker.appendChild(row);
      }
    }
    this.picker.hidden = this.picker.childElementCount === 0;
  }

  hidePicker() {
    this.pickerRequest++;
    this.picker.hidden = true;
  }

  focusAddress() {
    this.addressInput.focus();
    this.addressInput.select();
    void this.showPicker();
  }

  showFind() {
    this.findBar.hidden = false;
    this.findInput.focus();
    this.findInput.select();
  }

  hideFind() {
    this.findBar.hidden = true;
    this.surface?.stopFindInPage("clearSelection");
    void this.surface?.focus();
  }

  find(forward) {
    const text = this.findInput.value;
    if (text) this.surface?.findInPage(text, { forward, findNext: true });
  }

  updateFindResult(result = {}) {
    const active = result.activeMatchOrdinal ?? result.result?.activeMatchOrdinal ?? 0;
    const matches = result.matches ?? result.result?.matches ?? 0;
    this.findResult.textContent = `${active}/${matches}`;
  }

  toggleResponsive(force) {
    const visible = force == null ? this.emulationBar.hidden : Boolean(force);
    this.emulationBar.hidden = !visible;
    if (visible) this.applyEmulation();
    else {
      Object.assign(this.nativeHost.style, {
        inset: "0",
        width: "",
        height: "",
        left: "",
        top: "",
      });
      this.surface?.clearDeviceEmulation();
      this.surface?.setUserAgent(this.package.cleanUserAgent());
    }
  }

  applyEmulation() {
    let device =
      this.deviceSelect.value === "responsive" ? {} : DEVICE_PRESETS[this.deviceSelect.value];
    if (device?.width) this.widthInput.value = String(device.width);
    if (device?.height) this.heightInput.value = String(device.height);
    if (device?.deviceScaleFactor) this.dprInput.value = String(device.deviceScaleFactor);
    const normalized = normalizeEmulation({
      ...device,
      width: this.widthInput.value,
      height: this.heightInput.value,
      deviceScaleFactor: this.dprInput.value,
      scale: this.scaleSelect.value,
      mobile: this.mobileButton.classList.contains("selected") || device?.mobile,
      touch: this.mobileButton.classList.contains("selected") || device?.touch,
    });
    const fitScale = Math.min(
      this.content.clientWidth / normalized.width || 1,
      this.content.clientHeight / normalized.height || 1,
      1,
    );
    const scale = normalized.scale === "auto" ? fitScale : normalized.scale;
    const { scale: _scale, touch, ...electronOptions } = normalized;
    electronOptions.screenPosition = electronOptions.mobile ? "mobile" : "desktop";
    electronOptions.screenSize = { width: normalized.width, height: normalized.height };
    electronOptions.viewPosition = { x: 0, y: 0 };
    electronOptions.viewSize = { width: normalized.width, height: normalized.height };
    electronOptions.deviceScaleFactor = normalized.deviceScaleFactor;
    electronOptions.scale = scale;
    Object.assign(this.nativeHost.style, {
      inset: "auto",
      width: `${Math.round(normalized.width * scale)}px`,
      height: `${Math.round(normalized.height * scale)}px`,
      left: `${Math.max(0, (this.content.clientWidth - normalized.width * scale) / 2)}px`,
      top: `${Math.max(0, (this.content.clientHeight - normalized.height * scale) / 2)}px`,
    });
    this.nativeHost.dataset.touch = String(touch);
    this.surface?.setUserAgent(normalized.userAgent || this.package.cleanUserAgent());
    this.surface?.setDeviceEmulation(electronOptions);
  }

  renderState(state = {}) {
    const url = state.url && state.url !== "about:blank" ? state.url : this.item.url;
    if (document.activeElement !== this.addressInput) this.addressInput.value = url || "";
    this.backButton.disabled = !state.canGoBack;
    this.forwardButton.disabled = !state.canGoForward;
    this.reloadButton.classList.toggle("loading", Boolean(state.loading));
    this.reloadButton.title = state.loading ? "Stop" : "Reload";
    this.placeholderMessage.textContent = url ? "Loading…" : "New Tab";
    this.placeholder.hidden = Boolean(url) && state.visible !== false && !state.error;
    this.error.hidden = !state.error;
    if (state.error) {
      this.errorDetail.textContent =
        state.error.description || state.error.message || String(state.error.code || "");
    }
    this.hoverURL.textContent = state.hoverUrl || "";
    this.hoverURL.hidden = !state.hoverUrl;
  }

  showCrash(event = {}) {
    this.showError(new Error(`Page renderer stopped: ${event.reason || "unknown reason"}`));
  }

  showError(error) {
    this.error.hidden = false;
    this.errorDetail.textContent = error?.message || String(error);
    this.placeholder.hidden = true;
  }

  startScreenshots() {
    const capture = async () => {
      if (
        this.destroyed ||
        !this.surface ||
        !this.item.url ||
        this.item.lastSurfaceState.visible === false
      ) {
        return;
      }
      try {
        const dataURL = await this.surface.capturePage();
        if (!this.destroyed && dataURL)
          this.placeholder.style.backgroundImage = `url(${JSON.stringify(dataURL)})`;
      } catch {}
    };
    void capture();
    this.screenshotTimer = setInterval(capture, 1000);
  }

  updateFavorite(favorite) {
    this.favoriteButton.classList.toggle("selected", favorite);
    this.favoriteButton.querySelector(".icon").className =
      `icon icon-${favorite ? "star-full" : "star"}`;
  }

  updateFindVisibility() {
    if (this.findBar.hidden) this.showFind();
    else this.hideFind();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.screenshotTimer);
    this.screenshotTimer = null;
    this.overlayDisposable?.dispose?.();
    this.overlayDisposable = null;
    this.surface?.detach();
    this.subscriptions.dispose();
    for (const dispose of this.domDisposables.splice(0)) dispose();
    this.element.remove();
    if (this.item.view === this) this.item.view = null;
  }
}

module.exports = WebBrowserView;
