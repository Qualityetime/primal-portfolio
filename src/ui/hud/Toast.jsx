import { useEffect, useState } from 'react';
import { useStore } from '../useStore.js';

// Event-driven messages from the simulation (kill, harvest, cooked, …).
export function Toast({ store, visible }) {
  const toast = useStore(store);
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (!toast) return undefined;
    setShown(toast);
    const timer = setTimeout(() => setShown(current => (current?.id === toast.id ? null : current)), 2800);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!visible || !shown) return null;
  return <div className="toast" role="status" key={shown.id}>{shown.message}</div>;
}
