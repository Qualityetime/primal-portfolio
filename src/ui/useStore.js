import { useSyncExternalStore } from 'react';

// Subscribe a component to one engine store (src/engine/store.js). The engine
// publishes immutable snapshots at a fixed low rate, so this is the only React
// state the game loop ever touches.
const noopSubscribe = () => () => {};
export function useStore(store) {
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, () => (store ? store.get() : null));
}
