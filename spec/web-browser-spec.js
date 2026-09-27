const http = require("http");

describe("web-browser", () => {
  let mainModule;
  let service;
  let server;
  let origin;

  beforeAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 15000;
    server = http.createServer((request, response) => {
      if (request.url === "/cookie") {
        const hasCookie = /browser=ok/.test(request.headers.cookie || "");
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>${hasCookie ? "Cookie Shared" : "Cookie Missing"}</title><p>cookie</p>`,
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
    expect(restored.getURI()).toBe(item.getURI());
    expect(restored.url).toBe("https://example.com/path");
  });

  it("copies a tab into a new identity", async () => {
    const item = await service.open("https://example.com", { activate: false });
    const copy = item.copy();

    expect(copy.url).toBe(item.url);
    expect(copy.getURI()).not.toBe(item.getURI());
  });

  it("registers the reveal-tier command synchronously", () => {
    const commands = lumine.commands.findCommands({ target: lumine.workspace.getElement() });
    expect(commands.some(({ name }) => name === "web-browser:toggle-focus")).toBe(true);
  });

  it("loads a real page in WebContentsView and shares its global session", async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const first = await service.open(`${origin}/`);
    await conditionPromise(
      () => first.lastSurfaceState.title === "Browser Fixture",
      "first WebContentsView navigation",
      8000,
    );
    expect(first.lastSurfaceState.url).toBe(`${origin}/`);

    const second = await service.open(`${origin}/cookie`);
    await conditionPromise(
      () => second.lastSurfaceState.title === "Cookie Shared",
      "shared WebContentsView profile cookie",
      8000,
    );
    expect(second.lastSurfaceState.error).toBeNull();
  });
});
