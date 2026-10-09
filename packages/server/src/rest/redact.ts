import type { Instance } from '@browserglass/protocol';
import type { InstanceView } from '@browserglass/router';

/**
 * Strips `Instance.runtime.cdpWsUrl` before an `Instance`/`InstanceView`
 * reaches a REST caller. That field is documented as secret at its own
 * declaration (`@browserglass/protocol`'s `entities.ts`: "Secret. Leaking
 * this is full browser control."), because it is the raw, unauthenticated
 * Chrome DevTools Protocol WebSocket URL: whoever holds it can open
 * `Runtime.evaluate`/`Target.attachToTarget` directly against the
 * browser, skipping the router, the `cdp` capability's allowlist
 * (`cdp-passthrough-allowlist.ts`), every control lease, and presence
 * entirely.
 *
 * `router.describe()`/`router.list()` populate it deliberately
 * (`BrowserRouter.ts`'s own comment on `liveRuntimeByInstance`: "describe()
 * needs this real, live detail... for any instance this router process
 * itself launched"), because the two IN-PROCESS callers that actually
 * need it (`session/factory.ts` connecting a `CdpBridge`, `ws/cdp-upgrade.ts`'s
 * proxy) call the router directly and never go through this REST layer.
 * `GET /v1/instances/:instanceId` and `GET /v1/instances` used to hand
 * `view` (the whole `OBSERVER_BUNDLE`) back this exact
 * URL with zero redaction (found in a security audit): a read only token
 * that cannot click, navigate, or hold a lease could still read Chrome's
 * real debug socket and drive it unrestricted from outside this gateway
 * altogether. On `runtime-remote`/`runtime-docker`/`runtime-k8s` that
 * socket is a routable network endpoint, so this was immediately
 * exploitable, not merely a loopback-only concern the way `runtime-host`
 * is.
 *
 * `cdpPort` IS REDACTED TOO, and leaving it out was a real hole in the
 * first version of this file. Redacting `cdpWsUrl` alone closes nothing,
 * because Chrome serves its own unauthenticated `/json/version` on that
 * same port and hands the full URL straight back. Measured against this
 * gateway, with only `cdpPort` taken from an otherwise redacted
 * `GET /v1/instances/:instanceId` response:
 *
 *     $ curl http://127.0.0.1:51738/json/version
 *     "webSocketDebuggerUrl": "ws://127.0.0.1:51738/devtools/browser/94374977-..."
 *
 * The browser GUID, the one part a caller could not otherwise guess, is
 * in that reply. So `cdpPort` is not "ordinary operational detail", it is
 * the same secret in two hops, and it has to go the same way. The unit
 * tests did not catch this because they asserted `cdpWsUrl` was redacted,
 * which was true and insufficient.
 *
 * Everything else on `runtime` (`kind`, `pid`, `chromeVersion`,
 * `startedAt`, `profilePath`, ...) stays: those are ordinary operational
 * detail a `view` capable caller has a legitimate reason to read from an
 * observability route, and none of them reaches the allowlist-free,
 * lease-free socket that `ws/cdp-upgrade.ts`'s proxy exists specifically
 * so a REST or WS caller never has to touch directly.
 *
 * Fixed here, at the REST boundary, deliberately NOT in
 * `BrowserRouter.describe()`/`.list()` themselves: the router's own copy
 * is load bearing for the two in-process callers named above, both of
 * which call the router directly and would break if it stopped returning
 * the real URL.
 */
export function redactInstance(instance: Instance): Instance {
  if (instance.runtime === null) return instance;
  return { ...instance, runtime: { ...instance.runtime, cdpWsUrl: '[redacted]', cdpPort: null } };
}

/** {@link redactInstance}, applied to `view.instance`. Used by `GET /v1/instances/:instanceId` and, mapped over every row, `GET /v1/instances`. */
export function redactInstanceView(view: InstanceView): InstanceView {
  return { ...view, instance: redactInstance(view.instance) };
}
