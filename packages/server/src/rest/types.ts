import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AuthResolver,
  Capability,
  Principal,
  Store,
  TargetSummary,
} from '@browserglass/protocol';
import type { BrowserRouter, DriveResolution } from '@browserglass/router';
import type { TokenApi } from '../auth/types.js';
import type { Logger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { DownloadStore } from '../downloads/download-store.js';
import type { UploadStore } from '../files/upload-store.js';
import type { HookRegistry } from '../hooks/dispatch.js';
import type { SessionRegistry } from '../session/registry.js';

/**
 * What every `RestSessionDriver`/`RestCdpSender` method needs to act on an
 * instance the router has already authorised: `resolution` is the
 * `BrowserRouter.driveInstance()` answer (`routes/targets.ts`'s own
 * `resolveDrive`, the one call site that produces one), carrying
 * `sessionId`/`nodeId`/`local` so the driver can execute directly against
 * its own `SessionRegistry` when `local` is true and forward through
 * `BrowserRouter.dispatchAction` when it is not ("resolve through the
 * gate, then run direct or forward"). `principal` is
 * threaded through separately, not folded into `resolution`, because
 * `dispatchAction` needs one to make its own `driveInstance` call
 * (cache hit, cheap) and a `RestSessionDriver` method has no other way to
 * reach the caller's identity.
 */
export interface DrivingContext {
  readonly resolution: DriveResolution;
  readonly principal: Principal;
}

/**
 * The live, per-target driving surface a REST route needs to actually
 * operate a browser: list/create/close targets, navigate, take a
 * screenshot, and dispatch click/type input. This is deliberately NOT the
 * raw CDP passthrough ({@link RestCdpSender}, a different capability and a
 * different safety posture) and NOT `SessionApi` (`session/session-api.ts`'s
 * `bg.sessions`, which is live inspection and moderation, not driving).
 *
 * Every method takes a {@link DrivingContext}, not a bare `sessionId`:
 * `routes/targets.ts` resolves one through the router's `driveInstance`
 * gate before ever reaching here (see that file's own module doc), and a
 * driver implementation (`session/rest-driver.ts`'s `createRestSessionDriver`)
 * needs `resolution.nodeId`/`.local` to decide whether to run against its
 * own local `SessionRegistry` or forward through `BrowserRouter.dispatchAction`,
 * not only `resolution.sessionId` for the local case a bare string used to
 * carry.
 */
export interface RestSessionDriver {
  listTargets(drive: DrivingContext): Promise<readonly TargetSummary[]>;
  createTarget(drive: DrivingContext, opts: { readonly url?: string }): Promise<TargetSummary>;
  closeTarget(drive: DrivingContext, targetId: string): Promise<void>;
  navigate(
    drive: DrivingContext,
    targetId: string,
    kind: 'goto' | 'back' | 'forward' | 'reload' | 'stop',
    params: { readonly url?: string; readonly ignoreCache?: boolean },
  ): Promise<{ readonly url: string; readonly title: string; readonly loading: boolean } | null>;
  screenshot(
    drive: DrivingContext,
    targetId: string,
    opts: {
      readonly format?: 'png' | 'jpeg';
      readonly quality?: number;
      readonly fullPage?: boolean;
    },
  ): Promise<{
    readonly format: 'png' | 'jpeg';
    readonly data: string;
    readonly width: number;
    readonly height: number;
  }>;
  click(
    drive: DrivingContext,
    targetId: string,
    opts: { readonly x: number; readonly y: number; readonly button?: 'left' | 'middle' | 'right' },
  ): Promise<void>;
  type(drive: DrivingContext, targetId: string, text: string): Promise<void>;
  /**
   * Attaches already-staged uploads to an `<input type="file">`.
   *
   * `uploadIds`, never paths. That is not a stylistic choice: it is the
   * boundary that makes file upload safe. The implementation resolves each
   * id against the gateway's own `UploadStore`, scoped to `tenantId`, and
   * the paths it hands to CDP are ones that store composed from a root it
   * owns. There is deliberately no overload, option, or escape hatch here
   * that takes a path from a caller, because one would immediately become
   * a read-any-file-on-the-node primitive with the browser as the
   * exfiltration channel. See `files/safe-name.ts` for the whole argument.
   *
   * `tenantId` is passed explicitly rather than read off
   * `drive.principal`, so an implementation cannot accidentally resolve an
   * upload under a tenant the request was not made for.
   */
  setInputFiles(
    drive: DrivingContext,
    targetId: string,
    req: {
      readonly selector: string;
      readonly uploadIds: readonly string[];
      readonly tenantId: string;
    },
  ): Promise<{ readonly files: readonly string[] }>;
}

/**
 * The minimal port `POST .../targets/:targetId/cdp` needs: one already
 * allowlist-cleared CDP method, sent scoped to one target under one
 * session. `cdp-allowlist.ts`'s `isCdpMethodAllowed` is checked by the
 * route handler BEFORE this is ever called; an implementation of this port
 * must never re-derive or second-guess that decision, only resolve
 * `drive`/`targetId` to a live CDP session (mirroring
 * `ManagedSession.navigate()`'s own `ensureAttached` step, or forward
 * through `BrowserRouter.dispatchAction` for a non local `drive.resolution`)
 * and send.
 */
export interface RestCdpSender {
  send(
    drive: DrivingContext,
    targetId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Everything a REST route handler needs. One instance is built once at
 * `createBrowserGlass` time and reused for every request.
 */
export interface RestContext {
  readonly config: ResolvedConfig;
  /** A getter, not a plain field: `router` is only populated once `start()` resolves. */
  readonly getRouter: () => BrowserRouter | undefined;
  readonly store: Store | undefined;
  readonly tokens: TokenApi;
  readonly resolver: AuthResolver | undefined;
  readonly hooks: HookRegistry;
  readonly logger: Logger;
  readonly isAccepting: () => boolean;
  readonly isReady: () => boolean;
  /** See {@link RestSessionDriver}'s own doc comment. Optional so a hand built `RestContext` (this package's own tests) may still omit it; `createBrowserGlass` (`src/index.ts`) always wires one. */
  readonly driver?: RestSessionDriver;
  /** See {@link RestCdpSender}'s own doc comment. Optional for the same reason `driver` is. */
  readonly cdp?: RestCdpSender;
  /**
   * The staging area the `/v1/upload/*` routes write into and
   * `POST .../targets/:targetId/files` reads out of (`files/upload-store.ts`).
   * Optional for the same reason `driver` is: a hand built `RestContext`
   * (this package's own tests) may omit it, and `createBrowserGlass`
   * always wires one. A route that needs it and finds it unset answers
   * 503 rather than pretending the feature is absent.
   */
  readonly uploads?: UploadStore;
  /**
   * The completed-download staging area `GET /v1/downloads/:token`
   * (`routes/downloads.ts`) reads out of, and `session/managed-session.ts`'s
   * `dispatchEffect` writes into on every `download.completed` core
   * effect. Optional for the same reason `uploads` is: a hand built
   * `RestContext` (this package's own tests) may omit it, and
   * `createBrowserGlass` always wires one. The route that needs it and
   * finds it unset answers 503, matching `requireUploads`'s own precedent.
   */
  readonly downloads?: DownloadStore;
  /**
   * The process wide `instanceId` to live `ManagedSession` map
   * (`session/registry.ts`), the same instance `createBrowserGlass`
   * (`src/index.ts`) already builds `sessionApi`/`driver`/`cdp` over.
   * `routes/presence.ts` is the one REST consumer today: `GET
   * /v1/instances/:instanceId/viewers` needs the live per-viewer
   * presence/lease/subscription state that only a `ManagedSession` holds
   * (`ManagedSession.presenceEntries`, never persisted to `Store`, and
   * `SessionApi`/`RestSessionDriver` do not expose a viewer roster with
   * enough shape to answer "who is controlling what" without the caller
   * doing set intersection itself). Optional for the same reason
   * `driver`/`uploads`/`downloads` are: a hand built `RestContext` (this
   * package's own tests) may omit it, and the route answers 503 rather
   * than pretending the feature is absent.
   *
   * Keyed by `instanceId` (not `sessionId`, unlike
   * `session/rest-driver.ts`'s own `findLocalManaged`/`session-api.ts`'s
   * `findManaged`, both of which scan for a `sessionId` match): `SessionRegistry.get`
   * is already `instanceId` keyed, which is the natural key an
   * instance-scoped REST route resolves to first.
   */
  readonly sessionRegistry?: SessionRegistry;
}

/** A parsed request the router hands to a route handler: method, path params, query, and the resolved principal. */
export interface RestRequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly requestId: string;
  readonly principal: Principal;
  readonly body: unknown;
}

export type RestHandler = (ctx: RestContext, rctx: RestRequestContext) => Promise<void>;

/** One route table entry. `capability: null` means the route needs no capability check (still needs a principal unless `public` is set). */
export interface RestRoute {
  readonly method: string;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
  readonly capability: Capability | null;
  readonly public?: boolean;
  /**
   * When true, `dispatchRest` does NOT read or parse the request body, and
   * the handler owns the stream. Set by exactly one route,
   * `PUT /v1/upload/:uploadId`, whose body is file bytes rather than JSON:
   * the shared reader buffers to `limits.maxRequestBodyBytes` (1 MiB by
   * default), decodes UTF-8, and parses JSON, so leaving it on would both
   * corrupt the bytes and consume the stream before the handler ran.
   */
  readonly rawBody?: boolean;
  readonly handler: RestHandler;
}
