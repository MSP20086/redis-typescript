import type { ClientState, RedisState } from "./types";

export function watchKeys(
  state: RedisState,
  client: ClientState,
  keys: string[],
): void {
  for (const key of keys) {
    client.watching.add(key);
    const watchers = state.watchers.get(key) ?? new Set();
    watchers.add(client);
    state.watchers.set(key, watchers);
  }
}

export function unwatchAll(state: RedisState, client: ClientState): void {
  for (const key of client.watching) {
    const watchers = state.watchers.get(key);
    watchers?.delete(client);
    if (watchers?.size === 0) {
      state.watchers.delete(key);
    }
  }
  client.watching.clear();
  client.dirty = false;
}

export function touchKey(state: RedisState, key: string): void {
  for (const client of state.watchers.get(key) ?? []) {
    client.dirty = true;
  }
}
