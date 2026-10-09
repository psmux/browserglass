import type { EnvSource } from './types.js';

/**
 * Reads and normalises `process.env` exactly once. `createBrowserGlass`
 * calls this a single time at construction and never re-reads the
 * environment afterward: env vars are read once, at `createBrowserGlass`
 * time, not lazily.
 */
export function snapshotEnv(explicit?: EnvSource): EnvSource {
  return explicit ?? (process.env as EnvSource);
}

/** True for `1/true/yes/on` case insensitively, false for everything else including undefined. */
export function parseEnvBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return undefined;
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Bare ms number (`"30000"`) or a suffixed duration (`"30s"`, `"15m"`,
 * `"2h"`). Returns `undefined` on malformed input rather than throwing, so
 * callers can turn that into a `ConfigProblem` naming the offending var.
 */
export function parseEnvDuration(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const bare = Number(trimmed);
  if (trimmed.length > 0 && Number.isFinite(bare) && /^-?\d+(\.\d+)?$/.test(trimmed)) return bare;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(trimmed);
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const factor = DURATION_UNIT_MS[unit];
  if (factor === undefined) return undefined;
  return value * factor;
}

const SIZE_UNIT_BYTES: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/** Bare byte count (`"1048576"`) or a suffixed size (`"512mb"`, `"2gb"`). `undefined` on malformed input. */
export function parseEnvSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i.exec(trimmed);
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const factor = SIZE_UNIT_BYTES[unit];
  if (factor === undefined) return undefined;
  return Math.round(value * factor);
}

/** Bare integer or float. `undefined` on malformed input. */
export function parseEnvNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Space separated list, trimmed, empty entries dropped. `undefined` when the var is unset. */
export function parseEnvStringList(
  raw: string | undefined,
  separator: RegExp = /\s+/,
): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(separator).filter((s) => s.length > 0);
}
