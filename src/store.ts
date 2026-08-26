// Minimal observable store shared between the wizard UI and the chatbot so that
// a change made by either side (a slider move, or the advisor accepting an
// offer) keeps the other side in sync.

export interface Store<T> {
  getState(): T;
  setState(patch: Partial<T>): void;
  subscribe(fn: (state: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subscribers = new Set<(state: T) => void>();
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      subscribers.forEach((fn) => fn(state));
    },
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
