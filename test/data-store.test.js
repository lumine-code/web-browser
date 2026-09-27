const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserDataStore, MemoryBackend } = require("../lib/data-store");

function store() {
  return new BrowserDataStore({
    backend: new MemoryBackend(),
    indexedDB: null,
    BroadcastChannel: null,
  });
}

test("history is scoped and pruned", async () => {
  const data = store();
  const profile = { id: "global", persistent: true };
  await data.addHistory(profile, { url: "https://one.test", timestamp: 1 }, 2);
  await data.addHistory(profile, { url: "https://two.test", timestamp: 2 }, 2);
  await data.addHistory(profile, { url: "https://three.test", timestamp: 3 }, 2);
  assert.deepEqual(
    (await data.history(profile)).map(({ url }) => url),
    ["https://three.test", "https://two.test"],
  );
  data.close();
});

test("ephemeral profiles do not record history or permissions", async () => {
  const data = store();
  const profile = { id: "private", persistent: false };
  assert.equal(await data.addHistory(profile, { url: "https://one.test" }), null);
  assert.equal(await data.setPermission(profile, "https://one.test", "media", "allow"), null);
  assert.deepEqual(await data.history(profile), []);
  data.close();
});

test("favorites and permissions can be added and removed", async () => {
  const data = store();
  const profile = { id: "global", persistent: true };
  await data.setFavorite("workspace", "https://one.test", true);
  assert.equal(await data.isFavorite("workspace", "https://one.test"), true);
  await data.setPermission(profile, "https://one.test", "media", "allow");
  assert.equal((await data.permission(profile, "https://one.test", "media")).decision, "allow");
  await data.removePermission(profile, "https://one.test", "media");
  assert.equal(await data.permission(profile, "https://one.test", "media"), null);
  data.close();
});
