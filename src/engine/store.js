// Minimal external store: the bridge between the 60 Hz Three.js loop and React.
// The engine publishes throttled, plain-object snapshots; React subscribes with
// useSyncExternalStore (src/ui/useStore.js). No per-frame React state.

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? next(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of [...listeners]) listener();
    },
    // Shallow merge; listeners are only notified when a field actually changed.
    patch(partial) {
      let changed = false;
      for (const key in partial) if (!Object.is(state?.[key], partial[key])) { changed = true; break; }
      if (changed) this.set({ ...state, ...partial });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearListeners() { listeners.clear(); },
  };
}

// True when two plain objects have the same keys and identical values.
export function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.is(a[key], b[key])) return false;
  return true;
}
