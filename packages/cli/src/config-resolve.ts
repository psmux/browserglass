/**
 * The precedence engine `bgls config show --annotate` uses: built-in
 * defaults, `bgls.config.{ts,js,mjs,json,toml}` (discovered upward from
 * cwd via `c12`, or `--config`), `BGLS_*` environment variables (`__` for
 * nesting), then CLI flags, in that increasing order of priority
 * Per-key
 * provenance is tracked so `--annotate` can name which layer set each
 * value, without depending on `c12`'s own internal layer metadata shape.
 */

import { loadConfig } from 'c12';
import type { BglsConfig } from './config.js';

/** One layer's name, in increasing precedence order. */
export type ConfigLayerName = 'default' | 'config file' | 'environment' | 'cli flag';

const LAYER_ORDER: readonly ConfigLayerName[] = [
  'default',
  'config file',
  'environment',
  'cli flag',
];

/** Built-in defaults: the CLI flag defaults and the `BGLS_*` env var defaults. */
export const BGLS_DEFAULTS: BglsConfig = {
  listen: '127.0.0.1:7443',
  store: { url: 'sqlite:./bgls-data/bgls.db' },
  runtime: { kind: 'host', channel: 'chrome', headless: false },
  profiles: { dir: './bgls-data/profiles' },
  // 100, was 20: this node's own launch capacity default, raised to agree
  // with `runtime-host`'s own `maxConcurrentBrowsers` default
  // (`packages/runtime-host/src/runtime.ts`, also raised from 64 to 100)
  // rather than sitting well below what a real host can launch.
  node: { maxInstances: 100 },
  session: { idleTimeoutMs: 1_800_000, maxDurationMs: 14_400_000 },
  auth: { mode: 'dev' },
  observability: { logs: { format: process.stdout.isTTY ? 'pretty' : 'json' } },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Flattens a nested config object into `"a.b.c" -> value` entries for leaf (non-object) values only. */
export function flatten(obj: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isPlainObject(obj)) {
    if (prefix !== '') out.set(prefix.replace(/\.$/, ''), obj);
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}${key}`;
    if (isPlainObject(value)) {
      for (const [k, v] of flatten(value, `${path}.`)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function coerceEnvValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.length > 0 && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** Turns every `BGLS_*` environment variable into the nested `BglsConfig` shape the doc's `__`-for-nesting convention describes. */
export function envToConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('BGLS_') || raw === undefined) continue;
    const path = key
      .slice('BGLS_'.length)
      .split('__')
      .map((s) => s.toLowerCase());
    let node = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i] as string;
      const next = node[segment];
      node[segment] = isPlainObject(next) ? next : {};
      node = node[segment] as Record<string, unknown>;
    }
    node[path[path.length - 1] as string] = coerceEnvValue(raw);
  }
  return root;
}

/** Loads `bgls.config.{ts,js,mjs,json,toml}` via `c12`, discovered upward from `cwd`, or from an explicit `--config` path. Returns `{}` when none is found; never throws for a missing file. */
export async function loadConfigFile(
  explicitPath: string | undefined,
  cwd: string,
): Promise<{ readonly config: BglsConfig; readonly filepath: string | null }> {
  const result = await loadConfig<BglsConfig>({
    name: 'bgls',
    cwd,
    ...(explicitPath !== undefined ? { configFile: explicitPath } : {}),
    rcFile: false,
    globalRc: false,
    dotenv: true,
  });
  const config = result.config ?? {};
  // `c12` reports `configFile` as the bare search name (`"bgls.config"`)
  // even when nothing was found, not `null`/`undefined`; an empty
  // resolved config is the only reliable "nothing found" signal it gives.
  const found = Object.keys(config).length > 0;
  return { config, filepath: found ? (result.configFile ?? null) : null };
}

/** One resolved config value plus the layer that last set it. */
export interface AnnotatedValue {
  readonly path: string;
  readonly value: unknown;
  readonly layer: ConfigLayerName;
}

/** The result of {@link resolveAnnotated}. */
export interface ResolvedConfigReport {
  readonly merged: Record<string, unknown>;
  readonly values: readonly AnnotatedValue[];
  readonly configFilePath: string | null;
}

/**
 * Merges the four layers in increasing precedence order and, for every
 * leaf key that appears in any layer, records which layer's value won.
 * Deep merge for objects (implicit, via {@link flatten}'s per-leaf
 * tracking), last-layer-wins for a given key path, matching the doc's
 * "later wins per key, deep merge for objects" rule.
 */
export function resolveAnnotated(
  layers: Readonly<Record<ConfigLayerName, unknown>>,
  configFilePath: string | null,
): ResolvedConfigReport {
  const winner = new Map<string, { readonly value: unknown; readonly layer: ConfigLayerName }>();
  for (const layerName of LAYER_ORDER) {
    for (const [path, value] of flatten(layers[layerName])) {
      if (value === undefined) continue;
      winner.set(path, { value, layer: layerName });
    }
  }

  const merged: Record<string, unknown> = {};
  const values: AnnotatedValue[] = [];
  for (const [path, { value, layer }] of winner) {
    values.push({ path, value, layer });
    const segments = path.split('.');
    let node = merged;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      if (!isPlainObject(node[segment])) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1] as string] = value;
  }
  values.sort((a, b) => a.path.localeCompare(b.path));

  return { merged, values, configFilePath };
}
