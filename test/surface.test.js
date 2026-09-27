const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserSurface } = require("../lib/surface");

test("subscribes to popup-blocked through the generic core event channel", () => {
  const callbacks = new Map();
  const raw = {
    getState: () => ({}),
    onDidReceiveEvent(type, callback) {
      callbacks.set(type, callback);
      return { dispose() {} };
    },
    destroy() {},
  };
  const surface = new BrowserSurface(raw);
  let received;
  surface.on("popup-blocked", (event) => {
    received = event;
  });

  callbacks.get("popup-blocked")({ url: "https://popup.example" });
  assert.deepEqual(received, { url: "https://popup.example" });
  surface.destroy();
});

test("turns native destruction into one terminal package event", () => {
  let nativeDestroy;
  let destroyCalls = 0;
  const raw = {
    getState: () => ({}),
    onDidDestroy(callback) {
      nativeDestroy = callback;
      return { dispose() {} };
    },
    onDidReceiveEvent() {
      return { dispose() {} };
    },
    destroy() {
      destroyCalls++;
    },
  };
  const surface = new BrowserSurface(raw);
  const received = [];
  surface.on("destroyed", (event) => received.push(event));

  nativeDestroy({ reason: "guest-closed" });
  nativeDestroy({ reason: "duplicate" });
  assert.doesNotThrow(() => surface.respond("permission", "stale", { allow: false }));
  surface.destroy();

  assert.deepEqual(received, [{ reason: "guest-closed" }]);
  assert.equal(surface.destroyed, true);
  assert.equal(destroyCalls, 0);
});
