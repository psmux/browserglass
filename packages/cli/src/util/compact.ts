/**
 * Returns a shallow copy of `obj` with every key whose value is
 * `undefined` removed. Every optional-field object literal in this
 * package builds through this, because `tsconfig.base.json`'s
 * `exactOptionalPropertyTypes: true` treats `{ key: undefined }` (the key
 * present, holding `undefined`) as a different, disallowed type from the
 * key being absent entirely.
 */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}
