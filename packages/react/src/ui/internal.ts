/** Joins class names, skipping falsy values. Internal to the `ui` primitives. */
export function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ');
}
