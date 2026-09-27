const http = require("http");
const path = require("path");
const { ipcRenderer } = require("electron");
const { pathToFileURL } = require("url");
const { WebBrowserItem } = require("../lib/browser-item");
const WebBrowserView = require("../lib/browser-view");
const { BrowserSurface } = require("../lib/surface");

describe("web-browser", () => {
  let mainModule;
  let service;
  let server;
  let origin;

  beforeAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 15000;
    server = http.createServer((request, response) => {
      if (request.url === "/touch") {
        response.setHeader("content-type", "text/html");
        response.end(
          "<title>Touch Pending</title><script>document.title = `Touch ${navigator.maxTouchPoints} ${matchMedia('(pointer: coarse)').matches}`</script>",
        );
        return;
      }
      if (request.url === "/cookie") {
        const hasCookie = /browser=ok/.test(request.headers.cookie || "");
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>${hasCookie ? "Cookie Shared" : "Cookie Missing"}</title><p>cookie</p>`,
        );
        return;
      }
      if (request.url === "/keys") {
        response.setHeader("content-type", "text/html");
        response.end(
          "<title>Keyboard Fixture</title><script>document.addEventListener('keydown', event => event.stopPropagation())</script>",
        );
        return;
      }
      response.setHeader("content-type", "text/html");
      response.setHeader("set-cookie", "browser=ok; SameSite=Lax");
      response.end("<title>Browser Fixture</title><p>hello browser</p>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    await lumine.packages.activatePackage("web-browser");
    mainModule = lumine.packages.getActivePackage("web-browser").mainModule;
    service = mainModule.provideWebBrowser();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("web-browser");
  });

  it("opens independent pane items for the same URL", async () => {
    const first = await service.open("https://example.com", { activate: false });
    const second = await service.open("https://example.com", { activate: false });

    expect(first).not.toBe(second);
    expect(first.getURI()).not.toBe(second.getURI());
    expect(first.getAllowedLocations()).toEqual(["center"]);
    expect(first.getPath).toBeUndefined();
  });

  it("serializes and restores browser identity without using the page URL as the URI", async () => {
    const item = await service.open("https://example.com/path", { activate: false });
    const state = item.serialize();
    const restored = mainModule.deserialize(state);

    expect(state.deserializer).toBe("WebBrowserItem");
    expect(Object.keys(state)).toEqual([
      "deserializer",
      "version",
      "id",
      "url",
      "title",
      "storageScope",
    ]);
    expect(restored.getURI()).toBe(item.getURI());
    expect(restored.url).toBe("https://example.com/path");
  });

  it("copies a tab into a new identity", async () => {
    const item = await service.open("https://example.com", { activate: false });
    const copy = item.copy();

    expect(copy.url).toBe(item.url);
    expect(copy.getURI()).not.toBe(item.getURI());
    expect(item.getProfile()).toBe(item.getProfile());
  });

  it("attaches an adopted popup without reloading or hiding its existing page", async () => {
    const surface = {
      attach: jasmine.createSpy("attach"),
      detach: jasmine.createSpy("detach"),
      loadURL: jasmine.createSpy("loadURL"),
      setVisible: jasmine.createSpy("setVisible"),
      getState: () => ({ url: "https://popup.example/", visible: true }),
      registerOverlay: () => ({ dispose() {} }),
      capturePage: async () => null,
    };
    const item = {
      package: {
        syncFavorite: async () => {},
        cleanUserAgent: () => "Lumine Test",
        addressSuggestions: async () => [],
      },
      url: "https://popup.example/",
      adoptedSurface: true,
      lastSurfaceState: { url: "https://popup.example/", visible: true },
      ensureSurface: async () => surface,
      setView(view) {
        this.view = view;
      },
    };
    const view = new WebBrowserView(item);
    jasmine.attachToDOM(view.element);
    await conditionPromise(() => surface.attach.calls.any(), "adopted popup attach");

    expect(surface.loadURL).not.toHaveBeenCalled();
    expect(surface.setVisible).toHaveBeenCalledWith(true);
    expect(view.placeholder.hidden).toBe(true);
    const addressEditor = view.addressEditor;
    expect(addressEditor.isMini()).toBe(true);
    expect(view.addressEditorElement.matches("lumine-text-editor[mini].web-browser-address")).toBe(
      true,
    );
    expect(view.element.classList.contains("native-key-bindings")).toBe(false);
    expect(view.nativeHost.classList.contains("native-key-bindings")).toBe(false);
    expect(addressEditor.getPlaceholderText()).toBe("Search or enter address");
    expect(lumine.textEditors.roleFor(addressEditor)).toBe("input");
    const pickerRow = document.createElement("button");
    const picked = jasmine.createSpy("picked");
    view.pickerEntries = [{ row: pickerRow, run: picked }];
    view.picker.hidden = false;
    const addressInput =
      view.addressEditorElement.querySelector(".hidden-input") || view.addressEditorElement;
    addressInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.pickerIndex).toBe(0);
    addressInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(picked).toHaveBeenCalled();
    addressEditor.setText("https://typed.example/");
    view.focusAddress();
    expect(addressEditor.getSelectedText()).toBe("https://typed.example/");
    view.destroy();
    expect(addressEditor.isDestroyed()).toBe(true);
    expect(lumine.textEditors.roleFor(addressEditor)).toBeNull();
  });

  it("uses configured storage for workspace-opened URLs", () => {
    const previous = lumine.config.get("web-browser.dataStorage");
    lumine.config.set("web-browser.dataStorage", "workspace");
    const item = mainModule.openURI("https://example.com/from-opener");

    expect(item.storageScope).toBe("workspace");
    item.destroy();
    lumine.config.set("web-browser.dataStorage", previous);
  });

  it("claims only supported web documents from file URLs", () => {
    const previous = lumine.config.get("web-browser.autoReloadOnFileChange");
    lumine.config.set("web-browser.autoReloadOnFileChange", false);
    const html = mainModule.openURI(pathToFileURL(path.resolve("fixture.html")).toString());
    const archive = mainModule.openURI(pathToFileURL(path.resolve("fixture.mhtml")).toString());
    const script = mainModule.openURI(pathToFileURL(path.resolve("fixture.js")).toString());

    expect(html).toEqual(jasmine.any(Object));
    expect(html.filePath).toBe(path.resolve("fixture.html"));
    expect(archive).toEqual(jasmine.any(Object));
    expect(script).toBeUndefined();
    html.destroy();
    archive.destroy();
    lumine.config.set("web-browser.autoReloadOnFileChange", previous);
  });

  it("hands a persistent workspace profile and its roots to a new window", async () => {
    const openWindow = spyOn(lumine.application, "openWindow");
    const projectPath = path.resolve("workspace-profile");
    const result = await mainModule.open("https://example.com/new-window", {
      placement: "window",
      storageScope: "workspace",
      profile: {
        id: "web-browser/workspace/0123456789abcdef01234567",
        persistent: true,
        scope: "workspace",
      },
      projectPaths: [projectPath],
    });

    expect(result).toBeNull();
    const options = openWindow.calls.mostRecent().args[0];
    expect(options.locationsToOpen).toEqual([{ pathToOpen: projectPath, isDirectory: true }]);
    expect(options.urlsToOpen[0]).toContain(
      "profileId=web-browser%2Fworkspace%2F0123456789abcdef01234567",
    );
  });

  it("rejects a deep-link profile that contradicts its storage scope", () => {
    const open = spyOn(mainModule, "open");
    mainModule.handleURI({
      query: {
        url: "https://example.com/",
        storageScope: "ephemeral",
        profileId: "web-browser/global",
        profilePersistent: "true",
      },
    });

    expect(open).toHaveBeenCalledWith("https://example.com/", {
      storageScope: "ephemeral",
      profile: undefined,
    });
  });

  it("settles pending native requests when their item closes", () => {
    const replies = [];
    const item = {
      id: "closing-tab",
      surface: {
        cancelDownload: jasmine.createSpy("cancelDownload"),
        respond(type, requestId, response) {
          replies.push({ type, requestId, response });
        },
      },
    };
    mainModule.beginItemRequest(item, () =>
      mainModule.safeSurfaceResponse(item, "permission", "permission-1", { allow: false }),
    );
    const download = mainModule.beginItemRequest(item, () =>
      item.surface.cancelDownload("download-1"),
    );
    mainModule.downloads.set(mainModule.downloadKey(item, "download-1"), {
      item,
      pending: download,
    });

    mainModule.cleanupItemRequests(item);
    expect(replies).toEqual([
      { type: "permission", requestId: "permission-1", response: { allow: false } },
    ]);
    expect(item.surface.cancelDownload).toHaveBeenCalledOnceWith("download-1");
    expect(mainModule.downloads.size).toBe(0);
    expect(mainModule.pendingByItem.has(item)).toBe(false);
  });

  it("expires only the matching native request", () => {
    const replies = [];
    const item = { id: "request-tab", surface: { respond() {} } };
    mainModule.beginItemRequest(item, () => replies.push("expired"), "request-1");
    mainModule.beginItemRequest(item, () => replies.push("other"), "request-2");

    mainModule.handleRequestExpired(item, { requestId: "request-1", type: "permission" });

    expect(replies).toEqual(["expired"]);
    expect(mainModule.pendingByItem.get(item).size).toBe(1);
    mainModule.cleanupItemRequests(item);
  });

  it("waits for a surface that finishes creating during item destruction", async () => {
    let resolveSurface;
    const raw = {
      getState: () => ({}),
      destroy: jasmine.createSpy("destroy").and.returnValue(Promise.resolve()),
    };
    const item = new WebBrowserItem({ package: mainModule });
    item.surfacePromise = new Promise((resolve) => {
      resolveSurface = resolve;
    });

    const destroyed = item.destroy();
    resolveSurface(new BrowserSurface(raw));
    await destroyed;

    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("offsets native context-menu coordinates and honors edit flags", () => {
    const host = document.createElement("div");
    spyOn(host, "getBoundingClientRect").and.returnValue({ left: 120, top: 45 });
    const shown = spyOn(lumine.contextMenu, "show").and.returnValue(null);
    const item = {
      view: { nativeHost: host },
      getProfile: () => ({ persistent: true }),
      surface: { respond() {} },
    };

    mainModule.handleContextMenu(item, {
      requestId: "menu-1",
      x: 8,
      y: 12,
      isEditable: true,
      editFlags: {
        canUndo: false,
        canRedo: true,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true,
      },
    });

    const [target, template, options] = shown.calls.mostRecent().args;
    expect(target).toBe(host);
    expect(options.anchor).toEqual({ clientX: 128, clientY: 57 });
    expect(template.find(({ label }) => label === "Cut").enabled).toBe(false);
    expect(template.find(({ label }) => label === "Copy").enabled).toBe(true);
    expect(template.some(({ label }) => label === "Print…")).toBe(true);
  });

  it("registers the reveal-tier command synchronously", () => {
    const commands = lumine.commands.findCommands({ target: lumine.workspace.getElement() });
    expect(commands.some(({ name }) => name === "web-browser:toggle-focus")).toBe(true);
  });

  it("navigates when Enter is pressed in the mini address editor", async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const item = await service.open();
    await conditionPromise(() => item.view?.addressEditor, "mini address editor");
    item.view.addressEditor.setText(`${origin}/`);
    item.view.addressEditorElement.focus();
    const addressInput =
      item.view.addressEditorElement.querySelector(".hidden-input") ||
      item.view.addressEditorElement;
    addressInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    await conditionPromise(
      () => item.lastSurfaceState.title === "Browser Fixture",
      "address-bar navigation",
      8000,
    );
    expect(item.lastSurfaceState.url).toBe(`${origin}/`);
  });

  it("loads a real page in WebContentsView and shares its global session", async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const first = await service.open(`${origin}/`);
    try {
      await conditionPromise(
        () => first.lastSurfaceState.title === "Browser Fixture",
        "first WebContentsView navigation",
        8000,
      );
    } catch (error) {
      error.message += `: ${JSON.stringify(first.lastSurfaceState)}`;
      throw error;
    }
    expect(first.lastSurfaceState.url).toBe(`${origin}/`);

    const second = await service.open(`${origin}/cookie`);
    await conditionPromise(
      () => second.lastSurfaceState.title === "Cookie Shared",
      "shared WebContentsView profile cookie",
      8000,
    );
    expect(second.lastSurfaceState.error).toBeNull();
  });

  it("forwards workspace shortcuts from a real WebContentsView", async () => {
    jasmine.useRealClock();
    const workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    const forwardedWorkspace = jasmine.createSpy("forwarded workspace shortcut");
    const forwardedPalette = jasmine.createSpy("forwarded palette shortcut");
    const forwardedBrowser = jasmine.createSpy("forwarded browser shortcut");
    const forwardedLate = jasmine.createSpy("forwarded late shortcut");
    const commands = lumine.commands.add(workspaceElement, {
      "web-browser-spec:workspace-shortcut": forwardedWorkspace,
      "web-browser-spec:palette-shortcut": forwardedPalette,
      "web-browser-spec:browser-shortcut": forwardedBrowser,
      "web-browser-spec:late-shortcut": forwardedLate,
    });
    let lateKeymaps = null;
    const keymaps = lumine.keymaps.add("web-browser-workspace-shortcut-spec", {
      "lumine-workspace": {
        f1: "web-browser-spec:workspace-shortcut",
        "cmdorctrl-shift-p": "web-browser-spec:palette-shortcut",
      },
      ".web-browser": { "cmdorctrl-f": "web-browser-spec:browser-shortcut" },
    });

    try {
      const item = await service.open(`${origin}/keys`);
      await conditionPromise(
        () => item.lastSurfaceState.title === "Keyboard Fixture",
        "keyboard fixture navigation",
        8000,
      );
      await lumine.window.focus();
      await conditionPromise(() => document.hasFocus(), "spec window focus");
      await item.focus();
      const sendKey = async (keyCode, modifiers = []) => {
        const inputTarget = await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
          type: "keyDown",
          keyCode,
          modifiers,
        });
        expect(inputTarget).toBe("web-contents-view");
      };
      const commandModifier = process.platform === "darwin" ? "meta" : "control";

      await sendKey("F1");
      await conditionPromise(() => forwardedWorkspace.calls.any(), "forwarded workspace shortcut");
      await sendKey("P", [commandModifier, "shift"]);
      await conditionPromise(() => forwardedPalette.calls.any(), "forwarded palette shortcut");
      await sendKey("F", [commandModifier]);
      await conditionPromise(() => forwardedBrowser.calls.any(), "forwarded browser shortcut");

      lateKeymaps = lumine.keymaps.add("web-browser-late-shortcut-spec", {
        "lumine-workspace": { f2: "web-browser-spec:late-shortcut" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await sendKey("F2");
      await conditionPromise(() => forwardedLate.calls.any(), "forwarded late shortcut");
    } finally {
      lateKeymaps?.dispose();
      keymaps.dispose();
      commands.dispose();
    }
  });

  it("applies real touch and coarse-pointer emulation", async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const item = await service.open(`${origin}/touch`);
    await conditionPromise(
      () => item.lastSurfaceState.title?.startsWith("Touch "),
      "initial touch capability",
      8000,
    );

    await item.surface.setDeviceEmulation({
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      scale: 1,
      mobile: true,
      touch: true,
    });
    item.surface.reload();
    await conditionPromise(
      () => item.lastSurfaceState.title === "Touch 5 true",
      "touch emulation",
      8000,
    );
  });
});
