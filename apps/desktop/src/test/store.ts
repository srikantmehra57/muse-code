import { useAppStore } from "../lib/store";

type AppState = ReturnType<typeof useAppStore.getState>;

// Captured before any test mutates it; state fields are never mutated in
// place so sharing the reference back via setState(…, true) is safe.
const initial = useAppStore.getState();

export function seedStore(partial: Partial<AppState>) {
  useAppStore.setState(partial);
}

export function resetStore() {
  useAppStore.setState(initial, true);
}
