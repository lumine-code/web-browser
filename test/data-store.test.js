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

test("recent history can be limited to explicit address navigations", async () => {
  const data = store();
  const profile = { id: "global", persistent: true };
  await data.addHistory(profile, { url: "https://typed.test", timestamp: 1, explicit: true });
  await data.addHistory(profile, { url: "https://linked.test", timestamp: 2, explicit: false });
  assert.deepEqual(
    (await data.history(profile, { explicitOnly: true })).map(({ url }) => url),
    ["https://typed.test"],
  );
  data.close();
});

test("individual history entries can be removed", async () => {
  const data = store();
  const profile = { id: "global", persistent: true };
  const entry = await data.addHistory(profile, { url: "https://remove.test" });
  await data.removeHistory(entry.id, profile.id);
  assert.deepEqual(await data.history(profile), []);
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

test("broadcasts committed changes to other windows", async () => {
  class FakeBroadcastChannel {
    static channels = new Map();

    constructor(name) {
      this.name = name;
      let peers = FakeBroadcastChannel.channels.get(name);
      if (!peers) FakeBroadcastChannel.channels.set(name, (peers = new Set()));
      peers.add(this);
    }

    postMessage(data) {
      for (const peer of FakeBroadcastChannel.channels.get(this.name) || []) {
        if (peer !== this) peer.onmessage?.({ data });
      }
    }

    close() {
      FakeBroadcastChannel.channels.get(this.name)?.delete(this);
    }
  }

  const backend = new MemoryBackend();
  const first = new BrowserDataStore({ backend, BroadcastChannel: FakeBroadcastChannel });
  const second = new BrowserDataStore({ backend, BroadcastChannel: FakeBroadcastChannel });
  const changes = [];
  second.onDidChange((change) => changes.push(change));

  await first.setFavorite("workspace", "https://one.test", true);

  assert.deepEqual(changes, [
    {
      kind: "favorites",
      workspaceId: "workspace",
      url: "https://one.test",
      favorite: true,
    },
  ]);
  first.close();
  second.close();
});
