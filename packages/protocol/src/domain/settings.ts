/**
 * Settings resolution, the `BrowserSpec` merge algorithm. Five layers, merged low to high
 * priority: package defaults, tenant defaults, pool template (a full spec,
 * overwritten wholesale), app override, per request override. The request
 * layer is filtered through an `OverridePolicy` before merging, so a
 * disallowed field never reaches the merge and is instead reported back to
 * the caller in `rejected`, never thrown.
 */

import { MAX_INIT_SCRIPTS, MAX_INIT_SCRIPT_SOURCE_LENGTH } from './entities.js';
import type { BrowserSpec, ClientHintsSpec } from './entities.js';

/** One request field the policy refused to apply, with the value it fell back to. */
export interface RejectedOverride {
  field: keyof BrowserSpec;
  requestedValue: unknown;
  reason: 'not_overridable' | 'not_narrowing' | 'requires_pair';
  fallbackValue: unknown;
}

/** The bounds a merged and clamped `BrowserSpec` must respect. */
export interface OverridePolicyBounds {
  viewport: { minW: number; maxW: number; minH: number; maxH: number; maxDsf: number };
  launchTimeoutMs: { min: number; max: number };
  resources: { maxCpus: number; maxMemoryMb: number };
}

/** Which `BrowserSpec` fields a per request override may set, and which of those may only narrow (never loosen) the pool's value. */
export interface OverridePolicy {
  requestOverridable: readonly (keyof BrowserSpec)[];
  requestNarrowing: readonly (keyof BrowserSpec)[];
  bounds: OverridePolicyBounds;
}

/** Fields a request may never set at all (operator only, security critical). */
const NEVER_OVERRIDABLE: readonly (keyof BrowserSpec)[] = [
  'engine',
  'executablePath',
  'proxy',
  'extraArgs',
  'ignoreDefaultArgs',
  'env',
  'extensions',
  // `initScripts` runs with the full privilege of whatever page it lands
  // in (`entities.ts`'s own doc comment on the field), the same reason
  // `extraArgs`/`env`/`extensions` sit here: a request layer choosing its
  // own injected script is indistinguishable from a request layer
  // choosing its own Chrome flags.
  'initScripts',
  'ignoreHttpsErrors',
  'downloadDir',
  'uploadDir',
  // Which registered `RemoteEndpoint` a launch attaches to is an operator
  // placement decision (set on a pool template, a tenant default, or an
  // app default), never a live per request choice: an app picking its own
  // endpoint is indistinguishable from an app picking its own Chrome
  // flags, the same reasoning `proxy`/`extraArgs`/`extensions` already sit
  // here for. See `entities.ts`'s `BrowserSpec.remoteEndpointName` doc.
  'remoteEndpointName',
];

/** Fields a request may set only to narrow the pool's value, never to loosen it. */
const NARROWING_ONLY: readonly (keyof BrowserSpec)[] = [
  'resources',
  'acceptDownloads',
  'maxDownloadBytes',
  'stealth',
  'launchTimeoutMs',
];

/** Every other `BrowserSpec` field, freely overridable per request. */
const FREELY_OVERRIDABLE: readonly (keyof BrowserSpec)[] = [
  'channel',
  'headless',
  'viewport',
  'window',
  'userAgent',
  'clientHints',
  'locale',
  'timezoneId',
  'geolocation',
  'permissions',
  'colorScheme',
  'reducedMotion',
  'initialUrl',
];

const DEFAULT_BOUNDS: OverridePolicyBounds = {
  viewport: { minW: 320, maxW: 3840, minH: 240, maxH: 2160, maxDsf: 3 },
  launchTimeoutMs: { min: 5000, max: 120000 },
  resources: { maxCpus: 8, maxMemoryMb: 8192 },
};

/**
 * The default policy: a caller may set the freely overridable fields plus
 * narrow the narrowing only fields, and may never touch the security
 * critical fields in `NEVER_OVERRIDABLE`.
 */
export const STRICT_OVERRIDE_POLICY: OverridePolicy = Object.freeze({
  requestOverridable: Object.freeze([...FREELY_OVERRIDABLE, ...NARROWING_ONLY]),
  requestNarrowing: Object.freeze([...NARROWING_ONLY]),
  bounds: DEFAULT_BOUNDS,
});

/**
 * The permissive policy for single tenant, self hosted deployments where
 * the app is the deployer, must be an explicit opt in. Everything except
 * `executablePath` is overridable (still an RCE risk with no safe
 * narrowing story, so it stays denied even here).
 */
export const TRUSTED_OVERRIDE_POLICY: OverridePolicy = Object.freeze({
  requestOverridable: Object.freeze([
    ...FREELY_OVERRIDABLE,
    ...NARROWING_ONLY,
    'proxy',
    'extraArgs',
    'ignoreDefaultArgs',
    'env',
    'extensions',
    'ignoreHttpsErrors',
    'downloadDir',
    'uploadDir',
  ] as (keyof BrowserSpec)[]),
  requestNarrowing: Object.freeze([...NARROWING_ONLY]),
  bounds: DEFAULT_BOUNDS,
});

/** The package's built in `BrowserSpec` defaults, frozen, the lowest priority layer. */
export const DEFAULT_BROWSER_SPEC: BrowserSpec = Object.freeze({
  engine: 'chromium',
  channel: 'chrome',
  executablePath: null,
  headless: 'new',
  viewport: Object.freeze({ width: 1440, height: 900, deviceScaleFactor: 1 }),
  window: null,
  // The historical, single-window behaviour: a caller wanting parallel
  // streaming opts in explicitly, rather than every unconfigured spec
  // silently spawning an OS window per target.
  isolation: 'tab',
  userAgent: null,
  clientHints: null,
  locale: null,
  timezoneId: null,
  geolocation: null,
  permissions: Object.freeze([]),
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  proxy: null,
  extraArgs: Object.freeze([]),
  ignoreDefaultArgs: Object.freeze(['--disable-web-security']),
  env: Object.freeze({}),
  extensions: Object.freeze([]),
  stealth: 'off',
  initScripts: Object.freeze([]),
  ignoreHttpsErrors: false,
  downloadDir: null,
  uploadDir: null,
  acceptDownloads: false,
  maxDownloadBytes: null,
  resources: Object.freeze({ cpus: null, memoryMb: null, shmMb: null, pidsLimit: null }),
  initialUrl: null,
  launchTimeoutMs: 30000,
  remoteEndpointName: null,
}) as BrowserSpec;

const SHALLOW_MERGE_FIELDS: readonly (keyof BrowserSpec)[] = [
  'viewport',
  'window',
  'geolocation',
  'resources',
];
const REPLACE_WHOLESALE_FIELDS: readonly (keyof BrowserSpec)[] = [
  'clientHints',
  'extraArgs',
  'ignoreDefaultArgs',
  'extensions',
  'proxy',
  'initScripts',
];
const ADDITIVE_ARRAY_FIELDS: readonly (keyof BrowserSpec)[] = ['permissions'];
const MAP_MERGE_FIELDS: readonly (keyof BrowserSpec)[] = ['env'];

/** Merges a partial `BrowserSpec` layer over a base, applying the per field merge rules. */
function mergeSpec(base: BrowserSpec, layer: Partial<BrowserSpec>): BrowserSpec {
  const baseRecord = base as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseRecord };
  for (const key of Object.keys(layer) as (keyof BrowserSpec)[]) {
    const value = layer[key];
    if (value === undefined) continue;
    if (
      SHALLOW_MERGE_FIELDS.includes(key) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const baseValue = baseRecord[key];
      result[key] =
        baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)
          ? { ...(baseValue as Record<string, unknown>), ...(value as Record<string, unknown>) }
          : value;
    } else if (ADDITIVE_ARRAY_FIELDS.includes(key) && Array.isArray(value)) {
      const baseArr = baseRecord[key];
      const merged = Array.isArray(baseArr) ? [...baseArr] : [];
      for (const item of value as unknown[]) if (!merged.includes(item)) merged.push(item);
      result[key] = merged;
    } else if (MAP_MERGE_FIELDS.includes(key) && value !== null && typeof value === 'object') {
      const baseMap = baseRecord[key];
      result[key] = {
        ...(typeof baseMap === 'object' && baseMap !== null ? baseMap : {}),
        ...(value as Record<string, unknown>),
      };
    } else {
      // Scalar last non undefined wins; object-replace-wholesale fields
      // (REPLACE_WHOLESALE_FIELDS) also fall here, since replacing
      // wholesale is the same as "last value wins".
      result[key] = value;
    }
  }
  return result as unknown as BrowserSpec;
}

/** A full `BrowserSpec` layer (the pool template) overwrites the running spec at the top level rather than merging. */
function overlayFullSpec(_base: BrowserSpec, pool: BrowserSpec): BrowserSpec {
  return { ...pool };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps the numeric fields with layer declared bounds, applied once at the end of the merge. */
function clampSpec(spec: BrowserSpec, bounds: OverridePolicyBounds): BrowserSpec {
  const viewport = {
    width: clamp(spec.viewport.width, bounds.viewport.minW, bounds.viewport.maxW),
    height: clamp(spec.viewport.height, bounds.viewport.minH, bounds.viewport.maxH),
    deviceScaleFactor: clamp(spec.viewport.deviceScaleFactor, 1, bounds.viewport.maxDsf),
  };
  const launchTimeoutMs = clamp(
    spec.launchTimeoutMs,
    bounds.launchTimeoutMs.min,
    bounds.launchTimeoutMs.max,
  );
  const resources = {
    cpus:
      spec.resources.cpus === null ? null : clamp(spec.resources.cpus, 0, bounds.resources.maxCpus),
    memoryMb:
      spec.resources.memoryMb === null
        ? null
        : clamp(spec.resources.memoryMb, 0, bounds.resources.maxMemoryMb),
    shmMb: spec.resources.shmMb,
    pidsLimit: spec.resources.pidsLimit,
  };
  return { ...spec, viewport, launchTimeoutMs, resources };
}

/** One problem found by `validateSpec`, causing `resolveBrowserSpec` to throw a `SpecValidationError`. */
export interface SpecProblem {
  field: keyof BrowserSpec | 'spec';
  message: string;
}

/** Thrown by `resolveBrowserSpec` when the merged, clamped spec is internally inconsistent. Never thrown for a disallowed override, which is reported instead. */
export class SpecValidationError extends Error {
  constructor(readonly problems: readonly SpecProblem[]) {
    super(`invalid BrowserSpec: ${problems.map((p) => `${p.field}: ${p.message}`).join('; ')}`);
    this.name = 'SpecValidationError';
  }
}

/** Structural validation applied to the final merged and clamped spec. */
function validateSpec(spec: BrowserSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (spec.channel === 'chromium-headless-shell' && spec.headless === 'off') {
    problems.push({
      field: 'headless',
      message: 'chromium-headless-shell has no UI, headless cannot be off',
    });
  }
  if (
    (spec.proxy?.username && !spec.proxy?.password) ||
    (spec.proxy?.password && !spec.proxy?.username)
  ) {
    problems.push({
      field: 'proxy',
      message: 'proxy username and password must be supplied together or not at all',
    });
  }
  // See `MAX_INIT_SCRIPTS`/`MAX_INIT_SCRIPT_SOURCE_LENGTH`'s own doc
  // comments (`entities.ts`) for why these are structural limits rather
  // than an `OverridePolicyBounds` entry: `initScripts` is never on
  // `NARROWING_ONLY`, so there is no request layer value to clamp here,
  // only a pool/tenant/app supplied one to reject outright.
  //
  // Read through a local default rather than off `spec` directly. Every
  // other field this function validates predates `initScripts`, so a spec
  // built by any caller that has not been updated (a stored row from
  // before migration `0006`, a hand assembled spec in a test, an older
  // client's payload) simply has no such property, and reading `.length`
  // off it threw a `TypeError` from inside validation. That is the worst
  // shape this failure could take: it is not a rejected spec with a
  // `SpecValidationError` naming the field, it is a crash from a function
  // whose entire job is to turn bad input into a clean report. Absent
  // means no init scripts, which is the only reading that makes sense.
  const initScripts = spec.initScripts ?? [];
  if (initScripts.length > MAX_INIT_SCRIPTS) {
    problems.push({
      field: 'initScripts',
      message: `at most ${MAX_INIT_SCRIPTS} init scripts are allowed, got ${initScripts.length}`,
    });
  }
  for (const script of initScripts) {
    if (script.source.length > MAX_INIT_SCRIPT_SOURCE_LENGTH) {
      problems.push({
        field: 'initScripts',
        message: `init script '${script.name}' source exceeds ${MAX_INIT_SCRIPT_SOURCE_LENGTH} characters`,
      });
    }
  }
  return problems;
}

function isNarrower(field: keyof BrowserSpec, poolValue: unknown, requestValue: unknown): boolean {
  switch (field) {
    case 'acceptDownloads':
      // Request may only turn a true pool default into false, never the reverse.
      return poolValue === true && requestValue === false;
    case 'maxDownloadBytes': {
      if (requestValue === null) return false;
      if (poolValue === null) return true;
      return (
        typeof requestValue === 'number' &&
        typeof poolValue === 'number' &&
        requestValue <= poolValue
      );
    }
    case 'stealth': {
      const order: Record<string, number> = { off: 0, basic: 1, full: 2 };
      const requestRank = order[requestValue as string] ?? 0;
      const poolRank = order[poolValue as string] ?? 0;
      return requestRank <= poolRank;
    }
    case 'launchTimeoutMs':
      // Clamping applies regardless; any value is accepted here and narrowed by clampSpec.
      return true;
    case 'resources': {
      const req = requestValue as BrowserSpec['resources'];
      const pool = poolValue as BrowserSpec['resources'];
      const fields: (keyof BrowserSpec['resources'])[] = ['cpus', 'memoryMb', 'shmMb', 'pidsLimit'];
      return fields.every(
        (f) => req[f] === null || pool[f] === null || (req[f] as number) <= (pool[f] as number),
      );
    }
    default:
      return true;
  }
}

/** Splits a request layer into the fields the policy allows and the fields it rejects, before any merging happens. */
function splitByPolicy(
  request: Partial<BrowserSpec>,
  policy: OverridePolicy,
  poolOrLowerValue: BrowserSpec,
): { allowed: Partial<BrowserSpec>; rejected: RejectedOverride[] } {
  const allowed: Record<string, unknown> = {};
  const rejected: RejectedOverride[] = [];
  for (const key of Object.keys(request) as (keyof BrowserSpec)[]) {
    const value = request[key];
    if (value === undefined) continue;
    if (NEVER_OVERRIDABLE.includes(key) || !policy.requestOverridable.includes(key)) {
      rejected.push({
        field: key,
        requestedValue: value,
        reason: 'not_overridable',
        fallbackValue: poolOrLowerValue[key],
      });
      continue;
    }
    if (policy.requestNarrowing.includes(key) && !isNarrower(key, poolOrLowerValue[key], value)) {
      rejected.push({
        field: key,
        requestedValue: value,
        reason: 'not_narrowing',
        fallbackValue: poolOrLowerValue[key],
      });
      continue;
    }
    allowed[key] = value;
  }
  return { allowed: allowed as Partial<BrowserSpec>, rejected };
}

/** The five settings layers `resolveBrowserSpec` merges, lowest priority first. */
export interface BrowserSpecLayers {
  defaults: BrowserSpec;
  tenant?: Partial<BrowserSpec>;
  pool?: BrowserSpec;
  app?: Partial<BrowserSpec>;
  request?: Partial<BrowserSpec>;
}

/** The result of a settings resolution: the merged spec plus every request field the policy refused. */
export interface ResolveBrowserSpecResult {
  spec: BrowserSpec;
  rejected: readonly RejectedOverride[];
}

/**
 * Resolves a `BrowserSpec` from five layers. Rejects
 * anything the request may not set before merging, merges bottom up
 * (defaults, tenant, pool as a full overwrite, app, the allowed part of the
 * request), clamps numeric fields once at the end, then validates. An
 * invalid merged spec throws `SpecValidationError`; a disallowed request
 * field never throws, it is left at the pool's value and returned in
 * `rejected` so the caller's acquire still succeeds.
 */
export function resolveBrowserSpec(
  layers: BrowserSpecLayers,
  policy: OverridePolicy,
): ResolveBrowserSpecResult {
  let spec = layers.defaults;
  spec = layers.tenant ? mergeSpec(spec, layers.tenant) : spec;
  spec = layers.pool ? overlayFullSpec(spec, layers.pool) : spec;
  const preRequestSpec = spec;
  spec = layers.app ? mergeSpec(spec, layers.app) : spec;
  const { allowed, rejected } = splitByPolicy(layers.request ?? {}, policy, preRequestSpec);
  spec = mergeSpec(spec, allowed);
  spec = clampSpec(spec, policy.bounds);
  const problems = validateSpec(spec);
  if (problems.length) throw new SpecValidationError(problems);
  return { spec, rejected };
}

/** Re-exported so callers constructing a request layer's `clientHints` do not need a second import from `entities.js`. */
export type { ClientHintsSpec };
