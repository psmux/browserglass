/**
 * Minimal ambient module declarations for the small subset of `node:http`
 * and `node:fs` this package's daemon probe needs.
 *
 * This package is Node-only (unlike `protocol`/`client`/`react`, it is not
 * subject to `check-deps.mjs`'s Node-builtin gate), so `node:` imports are
 * allowed here. But no `@types/node` package is installed anywhere in this
 * workspace, and this package's `tsconfig.json` sets `lib: ["ES2023"]`
 * only. Elsewhere in the workspace the answer is a `globalThis` structural
 * cast, which works for ambient globals (`fetch`, `WebSocket`,
 * `setTimeout`) but not for importable modules: an `import` statement's
 * specifier needs a real module declaration to type-check at all. A scoped
 * `declare module` here is self-contained to this package's own
 * compilation unit (each package builds independently under project
 * references), so it carries none of the `declare global` collision
 * risk with a sibling package's ambient block.
 */
declare module 'node:http' {
  export interface MinimalIncomingMessage {
    statusCode?: number;
    on(event: 'data', listener: (chunk: unknown) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
  }
  export interface MinimalClientRequest {
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'timeout', listener: () => void): void;
    setTimeout(ms: number, cb?: () => void): void;
    destroy(): void;
    end(): void;
  }
  export interface RequestOptions {
    socketPath?: string;
    host?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  }
  export function request(
    options: RequestOptions,
    callback?: (res: MinimalIncomingMessage) => void,
  ): MinimalClientRequest;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
  export const platform: string;
  export const arch: string;
}
