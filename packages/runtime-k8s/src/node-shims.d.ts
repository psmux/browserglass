/**
 * Minimal ambient module declarations for the small subset of `node:https`,
 * `node:fs`, and `node:process` this package's kube API probe needs. See
 * `@browserglass/runtime-docker`'s own `node-shims.d.ts` for why this is a
 * scoped `declare module` rather than `@types/node` (not installed
 * anywhere in this workspace) or a `declare global` block: each package compiles independently under project references,
 * so this file's declarations affect only this package's own build.
 */
declare module 'node:https' {
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
    host?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
    ca?: string;
    // Only ever set true by an explicit, documented escape hatch; this
    // package never sets it itself. Declared for completeness.
    rejectUnauthorized?: boolean;
  }
  export function request(
    options: RequestOptions,
    callback?: (res: MinimalIncomingMessage) => void,
  ): MinimalClientRequest;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
  export const arch: string;
}
