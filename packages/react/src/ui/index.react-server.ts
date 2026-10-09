/**
 * `react-server` condition entry point for `@browserglass/react/ui`. See
 * `../index.react-server.ts` for the full rationale; the same guard
 * applies here since every primitive under this subpath renders DOM
 * elements and several (`AddressBar`, `ContextMenu`) call browser-only
 * APIs directly.
 */
throw new Error(
  '@browserglass/react/ui cannot be imported from a React Server Component. ' +
    "Import it only from a module marked 'use client', or from a client " +
    'component this server component renders.',
);

export {};
