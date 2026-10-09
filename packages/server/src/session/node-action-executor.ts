/**
 * The real `NodeActionExecutor` (`@browserglass/router`'s `LocalNode.ts`,
 * "the seam a driving surface fills with real CDP execution for a
 * `NodeActionRequest` dispatched to THIS node"). Before this file, nothing
 * in `@browserglass/server` built one: `lifecycle/wiring.ts` constructed
 * `LocalNode` with `actions` unset, so `LocalNode.dispatch()` could only
 * ever throw "no NodeActionExecutor configured". That was invisible in a
 * single node build (nothing ever called `dispatch()` on the local node;
 * `BrowserRouter.dispatchAction` is only reached for a foreign `nodeId`),
 * but it is exactly the gap `ws/peer-upgrade.ts`'s listener now depends on
 * being closed: a peer's `dispatch` request reaches `LocalNode.dispatch()`
 * addressed to THIS node, and from here on this node's own `LocalNode`
 * cannot tell a peer's request apart from a hypothetical future local one.
 *
 * `session/rest-driver.ts` already has this exact translation, one
 * `NodeActionRequest.kind` at a time, for the "local" branch of every REST
 * driving call (`findLocalManaged(registry, sessionId)` + a `ManagedSession`
 * method). This module is the same mapping, keyed by `instanceId` instead
 * of `sessionId` (`SessionRegistry` is keyed by `instanceId`,
 * `registry.ts`'s own doc), because a `NodeActionRequest` arriving over a
 * peer link only ever carries the instance id, never the session id: see
 * `extension-points.ts`'s own vocabulary, every variant of `NodeActionRequest`
 * names `instanceId`, none names `sessionId`.
 */

import {
  BglsError,
  type NodeActionRequest,
  type NodeActionResult,
  type NodeActionTarget,
  type TargetSummary,
} from '@browserglass/protocol';
import type { NodeActionExecutor } from '@browserglass/router';
import { isCdpMethodAllowed } from '../rest/cdp-passthrough-allowlist.js';
import type { ManagedSession } from './managed-session.js';
import type { SessionRegistry } from './registry.js';

/** `NodeActionTarget` (`extension-points.ts`) is deliberately narrower than `TargetSummary`, see that type's own doc. Mirrors `rest-driver.ts`'s own `targetSummaryFromNodeAction`, in the opposite direction: this node HAS the full `TargetSummary`, since the action executed locally, and only needs to narrow it for the wire reply, not fill in defaults for fields it never had. */
function narrowTarget(t: TargetSummary): NodeActionTarget {
  return { targetId: t.targetId, url: t.url, title: t.title };
}

/**
 * The honest refusal for "a peer asked this node to act on an instance it
 * holds no live `ManagedSession` for": a peer asking for an instance this
 * node does not own must be refused clearly, not silently mis-served. `E_INSTANCE_NOT_FOUND` (404, not retryable,
 * `ACQUIRE_ERROR_TABLE`) rather than `rest-driver.ts`'s own
 * `E_SESSION_NOT_LIVE` (409, retryable): that code means "this process
 * knows the instance but has not rebuilt its session yet" (a real,
 * transient, same node condition); from a PEER's point of view, an
 * instance id this node cannot find a session for at all is
 * indistinguishable from one it never owned, which is what
 * `E_INSTANCE_NOT_FOUND` already means everywhere else in this codebase's
 * error vocabulary.
 */
function notOwnedHere(instanceId: string): BglsError {
  return new BglsError(
    'E_INSTANCE_NOT_FOUND',
    `this node has no live session for instance "${instanceId}"`,
  );
}

function requireManaged(registry: SessionRegistry, instanceId: string): ManagedSession {
  const managed = registry.get(instanceId);
  if (!managed) throw notOwnedHere(instanceId);
  return managed;
}

/**
 * Builds the `NodeActionExecutor` `lifecycle/wiring.ts` gives `LocalNode`.
 * `registry` is this process's own `SessionRegistry`, the exact one
 * `ws/connection.ts`'s viewer path and `session/rest-driver.ts`'s REST path
 * already read: a peer's dispatch is a third caller of the same live
 * session pool, not a parallel one.
 */
export function createLocalNodeActionExecutor(registry: SessionRegistry): NodeActionExecutor {
  return {
    async execute(req: NodeActionRequest): Promise<NodeActionResult> {
      switch (req.kind) {
        case 'navigate': {
          const managed = requireManaged(registry, req.instanceId);
          await managed.navigate(
            req.targetId,
            req.op,
            req.url !== undefined ? { url: req.url } : {},
          );
          return { kind: 'navigate' };
        }
        case 'screenshot': {
          const managed = requireManaged(registry, req.instanceId);
          const shot = await managed.screenshotTarget(req.targetId, {
            ...(req.format !== undefined ? { format: req.format } : {}),
            ...(req.quality !== undefined ? { quality: req.quality } : {}),
            ...(req.fullPage !== undefined ? { fullPage: req.fullPage } : {}),
          });
          return {
            kind: 'screenshot',
            format: shot.format,
            data: shot.data,
            width: shot.width,
            height: shot.height,
          };
        }
        case 'click': {
          const managed = requireManaged(registry, req.instanceId);
          await managed.clickTarget(req.targetId, {
            x: req.x,
            y: req.y,
            ...(req.button !== undefined ? { button: req.button } : {}),
          });
          return { kind: 'click' };
        }
        case 'type': {
          const managed = requireManaged(registry, req.instanceId);
          await managed.typeTarget(req.targetId, req.text);
          return { kind: 'type' };
        }
        case 'target.list': {
          const managed = requireManaged(registry, req.instanceId);
          return { kind: 'target.list', targets: managed.listTargets().map(narrowTarget) };
        }
        case 'target.create': {
          const managed = requireManaged(registry, req.instanceId);
          const target = await managed.newTarget(req.url, undefined, undefined);
          return { kind: 'target.create', target: narrowTarget(target) };
        }
        case 'target.close': {
          const managed = requireManaged(registry, req.instanceId);
          await managed.closeTarget(req.targetId);
          return { kind: 'target.close' };
        }
        case 'cdp': {
          const managed = requireManaged(registry, req.instanceId);
          // Defence in depth: `isCdpMethodAllowed` is normally enforced
          // exactly once, at the REST edge (`rest/routes/targets.ts:296`,
          // `sendCdpCommand`, before `requireCdp` even runs). A peer's
          // `dispatch` frame reaches this case straight from
          // `ws/peer-upgrade.ts`'s `dispatch` branch
          // (`nodes.dispatch(nodeId, req)`), which never passes through
          // that route handler, so without rechecking here a peer holding
          // `peer.sharedSecret` could send `Runtime.evaluate` (or any other
          // `REFUSED_DOMAINS`/`REFUSED_METHODS` entry) to any instance this
          // node owns, even though the REST edge would have refused the
          // exact same call. Documented as a known gap in
          // `docs/cdp-and-interception.md`'s "The CDP allowlist is an edge
          // check, not defence in depth"; this closes it. Not a change to
          // the peer link's flat trust model (`peer-upgrade.ts`'s
          // `handleHello` doc): that model is deliberate and untouched,
          // this only makes sure the same allowlist decision is honoured
          // on both doors into `ManagedSession.sendCdp`.
          //
          // `E_FORBIDDEN`, not the REST edge's own `E_CDP_METHOD_NOT_ALLOWED`
          // (a `RestError`-only code, `rest/routes/targets.ts:297` to `:301`):
          // this error crosses the peer wire through `WebSocketNodeTransport`'s
          // own `codeFromWire` (`packages/router/src/node/WebSocketNodeTransport.ts:96`
          // to `:98`), which narrows any code outside `AcquireErrorCode`
          // (`packages/router/src/router/errors.ts:13` to `:38`) down to
          // `E_NODE_LOST`, discarding the very refusal this recheck exists
          // to report. `E_FORBIDDEN` is that table's own 403, not retryable
          // entry, the same semantics the REST edge's 403 carries; the
          // message (preserved verbatim across the wire, unlike the code)
          // still names the refused method.
          if (!isCdpMethodAllowed(req.method)) {
            throw new BglsError(
              'E_FORBIDDEN',
              `CDP method "${req.method}" is not on the passthrough allowlist.`,
            );
          }
          // Spread to a fresh, mutable object: `NodeActionRequest`'s `cdp`
          // variant types `params` as `Readonly<Record<string, unknown>>`
          // (the wire vocabulary is read only by contract), but
          // `ManagedSession.sendCdp`'s own signature (shared with
          // `RestCdpSender.send`) takes a plain mutable `Record`.
          const result = await managed.sendCdp(req.targetId, req.method, { ...req.params });
          return { kind: 'cdp', result };
        }
      }
    },
  };
}
