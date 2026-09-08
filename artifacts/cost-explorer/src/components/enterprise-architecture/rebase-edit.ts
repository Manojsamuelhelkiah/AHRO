const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keyFor = (value: unknown): string | undefined =>
  record(value) ? (typeof value.id === "string" ? value.id : typeof value.phase === "string" ? value.phase : undefined) : undefined;

/** Reapply only the original draft's changes, not a stale whole collection or a toggle. */
export function rebaseEdit(base: unknown, draft: unknown, latest: unknown): unknown {
  if (equal(base, draft)) return latest;
  if (Array.isArray(base) && Array.isArray(draft) && Array.isArray(latest)
    && [...base, ...draft, ...latest].every(item => typeof item === "string")) {
    const removed = base.filter(item => !draft.includes(item));
    const added = draft.filter(item => !base.includes(item));
    return [...new Set([...latest.filter(item => !removed.includes(item)), ...added])];
  }
  if (Array.isArray(base) && Array.isArray(draft) && Array.isArray(latest)
    && [...base, ...draft, ...latest].every(item => keyFor(item) !== undefined)) {
    const before = new Map(base.map(item => [keyFor(item), item]));
    const after = new Map(draft.map(item => [keyFor(item), item]));
    const result = latest.flatMap(item => {
      const key = keyFor(item);
      if (before.has(key) && !after.has(key)) return [];
      if (!after.has(key)) return [item];
      return [rebaseEdit(before.get(key), after.get(key), item)];
    });
    // An intentional retry also restores an edited record removed by the other writer.
    for (const item of draft) {
      if (!latest.some(current => keyFor(current) === keyFor(item)) && !equal(before.get(keyFor(item)), item)) {
        result.push(item);
      }
    }
    return result;
  }
  if (record(base) && record(draft) && record(latest)) {
    const result = { ...latest };
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      if (equal(base[key], draft[key])) continue;
      if (!(key in draft)) delete result[key];
      else result[key] = rebaseEdit(base[key], draft[key], latest[key]);
    }
    return result;
  }
  return draft;
}