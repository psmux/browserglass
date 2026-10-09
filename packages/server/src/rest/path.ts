/** Compiles an Express-style `/v1/instances/:instanceId` pattern into a matcher and its ordered param names. */
export function compilePath(pattern: string): {
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
} {
  const paramNames: string[] = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), paramNames };
}
