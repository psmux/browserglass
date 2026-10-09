/**
 * `react-server` condition entry point for `@browserglass/react`'s main
 * export. Resolved instead of `./index.ts` whenever a bundler's module
 * resolution advertises the `react-server` condition (a React Server
 * Component module graph). The `browser` and `react-server` export
 * conditions exist so importing from a server component fails at build
 * time with a readable message rather than at runtime with `WebSocket is
 * not defined`.
 *
 * Every export this package provides touches `WebSocket`, `document`, or
 * `createImageBitmap`, none of which exist in a server component's
 * runtime; the message below explains the fix (`'use client'` re-export
 * wrapper, or moving the import into a real client component) rather than
 * surfacing a bare `ReferenceError`.
 */
throw new Error(
  '@browserglass/react cannot be imported from a React Server Component. ' +
    '<BrowserGlass/> and every hook in this package touch WebSocket, document, ' +
    'and createImageBitmap directly. Import it only from a module marked ' +
    "'use client', or from a client component this server component renders.",
);

export {};
