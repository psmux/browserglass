/**
 * Builds an object containing only the entries of `fields` whose value is
 * not `undefined`. Used everywhere this package builds a value for a type
 * it does not own (protocol's `AuthContext`, `Principal`, `InstanceListFilter`,
 * and so on) from locally optional data: `tsconfig.base.json` sets
 * `exactOptionalPropertyTypes`, so an optional property declared `foo?: T`
 * (no explicit `| undefined`) rejects an object literal that sets `foo`
 * to `undefined` rather than omitting the key outright.
 */
/**
 * Strips `undefined` from a type. Deliberately a standalone alias, not
 * inlined into {@link compact}'s mapped type: a conditional type only
 * distributes over a union when its checked type is a genuinely naked
 * type parameter, and `T[K]` inside a mapped type is an indexed access,
 * not a naked parameter, so inlining `T[K] extends undefined ? never :
 * T[K]` would evaluate non-distributively and leave `undefined` in place.
 */
type WithoutUndefined<X> = X extends undefined ? never : X;

export function compact<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]: WithoutUndefined<T[K]> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]: WithoutUndefined<T[K]> };
}
