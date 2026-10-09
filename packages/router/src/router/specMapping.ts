/**
 * Maps a resolved `BrowserSpec` (the domain, merged launch configuration)
 * to a `BrowserSpecInput` (the content addressed `browser_specs` row shape
 * `Store.upsertBrowserSpec` stores), since the two are deliberately kept
 * distinct types: a stored spec row carries a
 * digest and flattened viewport fields a domain `BrowserSpec` does not.
 */

import type {
  BrowserSpec,
  BrowserSpecInput,
  ProfileSpec,
  ResolvedProfileSpec,
} from '@browserglass/protocol';

/**
 * The inverse of profile resolution: rebuilds a request-shaped `ProfileSpec`
 * from an already `ResolvedProfileSpec`, for `BrowserRouter.restart()`'s
 * `preserveProfile: false` path, which needs to hand `ProfileServicePort.resolve()`/`.lease()`
 * a fresh request for the exact same profile identity (same `key` for
 * persistent, same instance-derived key for ephemeral) after destroying the
 * old directory, so the relaunch gets a genuinely blank profile rather than
 * a stale in-memory guess at what the original request looked like. Mirrors
 * `ProfileService`'s own private `specFromResolved` (`../profiles/ProfileService.ts`),
 * which this file cannot import directly (`router -/-> profiles` internals,
 * only the `ProfileServicePort` seam).
 */
export function profileSpecFromResolved(resolved: ResolvedProfileSpec): ProfileSpec {
  if (resolved.mode === 'ephemeral')
    return { mode: 'ephemeral', ...(resolved.seed ? { seed: resolved.seed } : {}) };
  if (resolved.mode === 'template')
    return { mode: 'template', templateId: resolved.templateId ?? '' };
  return {
    mode: 'persistent',
    key: resolved.key,
    createIfMissing: true,
    ttlMs: resolved.ttlMs,
    snapshotOnRelease: resolved.snapshotOnRelease,
    ...(resolved.templateId ? { templateId: resolved.templateId } : {}),
  };
}

/**
 * Flattens a merged `BrowserSpec` into the shape `Store.upsertBrowserSpec`
 * persists.
 *
 * THE RETURN TYPE IS `Required<BrowserSpecInput>` AND THAT IS THE POINT.
 *
 * Three fields on `StoredBrowserSpec` are optional (`isolation`,
 * `clientHints`, `initScripts`), and each is optional for a good reason:
 * every one is a column added by a migration after the type and the table
 * already existed, so a row written before that migration, or a caller
 * assembling an input against an older build, genuinely carries no opinion.
 * That optionality is correct for anything READING a stored row.
 *
 * It is exactly wrong here. This function maps from a fully resolved domain
 * `BrowserSpec` in which all three fields are present and required, so it
 * always has an opinion and there is never a reason for it to omit one. But
 * because the target type marks them optional, forgetting one is not a type
 * error: the object still satisfies `BrowserSpecInput`, the field is
 * dropped, `upsertBrowserSpec` mints a row with that column null, and the
 * value vanishes with nothing raised anywhere.
 *
 * That has now happened twice. `clientHints` was dropped once and the
 * comment on it below records the incident. `initScripts` was then added to
 * the schema and dropped here in exactly the same way, which cost an
 * `initScripts` payload of 2,860 characters its trip to the page: the pool
 * row held them, `rowToPool` carried them into `pool.template`,
 * `overlayFullSpec` returned them, this function silently discarded them,
 * `doAcquire` filed the instance against a second spec row with
 * `init_scripts` null, and `createTargetRegistry` was handed an empty
 * array. The measurable symptom was `String(window.alert)` still reading
 * `[native code]` on a page that had asked for a dialog neutraliser, and a
 * parse time `form.submit()` going unblocked.
 *
 * A comment did not stop the second occurrence, so this is a type instead.
 * `Required<BrowserSpecInput>` makes every one of those optional keys
 * mandatory FOR THIS FUNCTION ONLY, without changing what the stored type
 * permits elsewhere: the result is still assignable to `BrowserSpecInput`,
 * so every caller is unaffected. Add a field to `StoredBrowserSpec`,
 * optional or not, and this function stops compiling until it is mapped.
 * That is the whole mechanism, and it is the reason a third occurrence
 * cannot be written.
 */
export function toStoredSpecInput(spec: BrowserSpec): Required<BrowserSpecInput> {
  return {
    engine: spec.engine,
    channel: spec.channel,
    headless: spec.headless,
    viewportW: spec.viewport.width,
    viewportH: spec.viewport.height,
    dpr: spec.viewport.deviceScaleFactor,
    locale: spec.locale,
    timezone: spec.timezoneId,
    userAgent: spec.userAgent,
    // Travels with `userAgent` on the line above, and has to: a browser
    // whose UA string says one thing while `navigator.userAgentData` says
    // another is presenting two different identities, and a bot check
    // comparing the two sees exactly the inconsistency it is looking for.
    // `navigator.userAgentData` is built from Chrome's own brand list and
    // is NOT parsed back out of the UA string, so it can only be aligned
    // by supplying it explicitly.
    //
    // The store round trip for this field only started working in the
    // `0005_browser_spec_client_hints` migration; before that
    // `StoredBrowserSpec` had no such field at all and `mappers.ts`
    // expanded a hardcoded `clientHints: null`. Dropping it here would
    // have reproduced the same "accepted, then silently discarded" bug one
    // layer up, which is precisely how the `userAgent` field went
    // unnoticed for so long.
    clientHints: spec.clientHints,
    // Dropped on the way in until this was fixed, in precisely the way
    // `clientHints` above was dropped before it. These are the scripts
    // `createTargetRegistry` installs through
    // `Page.addScriptToEvaluateOnNewDocument`, so they are the only thing
    // that can run BEFORE a page's own first script. A caller's submit
    // blocker and dialog neutraliser both depend on that ordering: a
    // stopgap that installs them after load still leaves an `alert()`
    // fired at parse time to wedge the target, which has been measured at
    // just over 8,000ms and then permanently.
    initScripts: spec.initScripts,
    // Dropped on the way in until this was fixed, in precisely the way
    // `clientHints`/`initScripts` above were dropped before it. This is
    // the ONLY channel `RemoteRuntime.launch`
    // (`packages/runtime-remote/src/runtime.ts`) has for choosing which
    // operator-registered `RemoteEndpoint` a launch attaches to (`router`'s
    // `LocalNode` reads `Pool.template.remoteEndpointName` and populates
    // `LaunchRequest.labels[REMOTE_ENDPOINT_LABEL_KEY]` from it), so
    // dropping it here meant every acquire against a `'remote'` runtime
    // kind threw `E_SPEC_CONFLICT` regardless of how the pool's spec was
    // configured, no matter what an operator set on `acquire` or on the
    // pool template.
    remoteEndpointName: spec.remoteEndpointName ?? null,
    proxy: spec.proxy ? { server: spec.proxy.server, bypass: spec.proxy.bypass } : null,
    args: spec.extraArgs,
    extensions: spec.extensions.map((e) => `${e.kind}:${e.value}`),
    stealth: spec.stealth,
    isolation: spec.isolation,
    limits: {
      cpus: spec.resources.cpus,
      memoryMb: spec.resources.memoryMb,
      shmMb: spec.resources.shmMb,
      pidsLimit: spec.resources.pidsLimit,
      launchTimeoutMs: spec.launchTimeoutMs,
    },
  };
}
