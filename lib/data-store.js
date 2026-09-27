const { EventHub } = require("./event-hub");

const STORES = ["history", "favorites", "permissions"];

function makeId(parts) {
  return parts.map((part) => encodeURIComponent(String(part))).join("|");
}

class MemoryBackend {
  constructor() {
    this.stores = new Map(STORES.map((name) => [name, new Map()]));
  }

  async all(store) {
    return [...this.stores.get(store).values()].map((value) => ({ ...value }));
  }

  async put(store, record) {
    this.stores.get(store).set(record.id, { ...record });
    return record;
  }

  async delete(store, id) {
    this.stores.get(store).delete(id);
  }

  async clear(store) {
    this.stores.get(store).clear();
  }

  close() {}
}

class IndexedDbBackend {
  constructor(indexedDB, databaseName = "web-browser") {
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.databasePromise = this.open();
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of STORES) {
          if (!database.objectStoreNames.contains(store))
            database.createObjectStore(store, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async transaction(store, mode, run) {
    const database = await this.databasePromise;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      let result;
      try {
        result = run(transaction.objectStore(store));
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result?.result ?? result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  all(store) {
    return this.transaction(store, "readonly", (objectStore) => objectStore.getAll());
  }

  put(store, record) {
    return this.transaction(store, "readwrite", (objectStore) => objectStore.put(record));
  }

  delete(store, id) {
    return this.transaction(store, "readwrite", (objectStore) => objectStore.delete(id));
  }

  clear(store) {
    return this.transaction(store, "readwrite", (objectStore) => objectStore.clear());
  }

  async close() {
    (await this.databasePromise).close();
  }
}

class BrowserDataStore {
  constructor(options = {}) {
    const indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.backend =
      options.backend ||
      (indexedDB ? new IndexedDbBackend(indexedDB, options.databaseName) : new MemoryBackend());
    this.events = new EventHub();
    this.channel = null;
    const Broadcast =
      options.BroadcastChannel === undefined
        ? globalThis.BroadcastChannel
        : options.BroadcastChannel;
    if (Broadcast) {
      this.channel = new Broadcast("web-browser");
      this.channel.onmessage = ({ data }) => this.events.emit("change", data);
    }
  }

  onDidChange(callback) {
    return this.events.on("change", callback);
  }

  announce(change) {
    this.events.emit("change", change);
    this.channel?.postMessage(change);
  }

  async addHistory(profile, entry, maximum = 200) {
    if (!profile?.persistent || maximum <= 0 || !entry?.url) return null;
    const timestamp = Number(entry.timestamp) || Date.now();
    const id = makeId([profile.id, entry.url]);
    const existing = (await this.backend.all("history")).find((item) => item.id === id);
    const record = {
      id,
      profileId: profile.id,
      url: entry.url,
      title: entry.title || entry.url,
      timestamp,
      explicit: existing?.explicit === true || entry.explicit !== false,
    };
    await this.backend.put("history", record);
    const all = (await this.backend.all("history"))
      .filter((item) => item.profileId === profile.id)
      .sort((a, b) => b.timestamp - a.timestamp);
    await Promise.all(all.slice(maximum).map((item) => this.backend.delete("history", item.id)));
    this.announce({ kind: "history", profileId: profile.id });
    return record;
  }

  async history(profile, options = {}) {
    if (!profile?.persistent) return [];
    const query = String(options.query || "")
      .trim()
      .toLowerCase();
    const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
    return (await this.backend.all("history"))
      .filter((item) => item.profileId === profile.id)
      .filter((item) => !options.explicitOnly || item.explicit === true)
      .filter(
        (item) =>
          !query ||
          item.url.toLowerCase().includes(query) ||
          item.title.toLowerCase().includes(query),
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async clearHistory(profile) {
    const records = await this.backend.all("history");
    await Promise.all(
      records
        .filter((item) => !profile || item.profileId === profile.id)
        .map((item) => this.backend.delete("history", item.id)),
    );
    this.announce({ kind: "history", profileId: profile?.id || null });
  }

  async removeHistory(id, profileId) {
    await this.backend.delete("history", id);
    this.announce({ kind: "history", profileId });
  }

  async favorites(workspaceId) {
    return (await this.backend.all("favorites"))
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => a.url.localeCompare(b.url));
  }

  async isFavorite(workspaceId, url) {
    return (await this.favorites(workspaceId)).some((item) => item.url === url);
  }

  async setFavorite(workspaceId, url, favorite) {
    const id = makeId([workspaceId, url]);
    if (favorite) await this.backend.put("favorites", { id, workspaceId, url });
    else await this.backend.delete("favorites", id);
    this.announce({ kind: "favorites", workspaceId, url, favorite });
    return favorite;
  }

  async toggleFavorite(workspaceId, url) {
    const favorite = !(await this.isFavorite(workspaceId, url));
    return this.setFavorite(workspaceId, url, favorite);
  }

  async permission(profile, origin, permission) {
    if (!profile?.persistent) return null;
    const id = makeId([profile.id, origin, permission]);
    return (await this.backend.all("permissions")).find((record) => record.id === id) || null;
  }

  async setPermission(profile, origin, permission, decision) {
    if (!profile?.persistent) return null;
    const record = {
      id: makeId([profile.id, origin, permission]),
      profileId: profile.id,
      origin,
      permission,
      decision,
      updatedAt: Date.now(),
    };
    await this.backend.put("permissions", record);
    this.announce({
      kind: "permissions",
      profileId: profile.id,
      origin,
      permission,
      decision,
    });
    return record;
  }

  async removePermission(profile, origin, permission) {
    if (!profile?.persistent) return;
    await this.backend.delete("permissions", makeId([profile.id, origin, permission]));
    this.announce({
      kind: "permissions",
      profileId: profile.id,
      origin,
      permission,
      decision: null,
    });
  }

  async permissions(profile, origin) {
    if (!profile?.persistent) return [];
    return (await this.backend.all("permissions"))
      .filter((item) => item.profileId === profile.id && (!origin || item.origin === origin))
      .sort((a, b) => a.permission.localeCompare(b.permission));
  }

  async clearPermissions(profile, origin) {
    const records = await this.backend.all("permissions");
    await Promise.all(
      records
        .filter(
          (item) =>
            (!profile || item.profileId === profile.id) && (!origin || item.origin === origin),
        )
        .map((item) => this.backend.delete("permissions", item.id)),
    );
    this.announce({ kind: "permissions", profileId: profile?.id || null, origin: origin || null });
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.backend.close();
    this.events.dispose();
  }
}

module.exports = { BrowserDataStore, IndexedDbBackend, MemoryBackend, makeId };
