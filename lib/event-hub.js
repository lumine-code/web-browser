class EventHub {
  constructor() {
    this.listeners = new Map();
    this.disposed = false;
  }

  on(name, callback) {
    if (this.disposed) return { dispose() {} };
    let callbacks = this.listeners.get(name);
    if (!callbacks) this.listeners.set(name, (callbacks = new Set()));
    callbacks.add(callback);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        callbacks.delete(callback);
        if (callbacks.size === 0) this.listeners.delete(name);
      },
    };
  }

  emit(name, value) {
    for (const callback of [...(this.listeners.get(name) || [])]) callback(value);
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}

function disposeAll(disposables) {
  while (disposables.length > 0) {
    try {
      disposables.pop()?.dispose?.();
    } catch (error) {
      console.error("Unable to dispose web-browser subscription", error);
    }
  }
}

module.exports = { EventHub, disposeAll };
