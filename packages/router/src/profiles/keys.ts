/**
 * Profile key namespacing. The caller supplied `key` is
 * never used as a filesystem path component; only the database generated
 * `profileId` is, which removes path traversal from the threat model
 * entirely.
 */

import { profileErr } from './errors.js';

/** The caller supplied profile key format. */
export const CALLER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** Reserved caller key prefixes, rejected with `E_PROFILE_KEY_RESERVED`. */
export const RESERVED_KEY_PREFIXES = ['eph:', 'bgls:'] as const;

/**
 * Validates a caller supplied persistent profile key. Throws
 * `E_PROFILE_KEY_INVALID` if it does not match {@link CALLER_KEY_RE}, or
 * `E_PROFILE_KEY_RESERVED` if it starts with a reserved prefix.
 */
export function validateCallerKey(key: string): void {
  for (const prefix of RESERVED_KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw profileErr(
        'E_PROFILE_KEY_RESERVED',
        `profile key "${key}" starts with the reserved prefix "${prefix}"`,
        { details: { key, prefix } },
      );
    }
  }
  if (!CALLER_KEY_RE.test(key)) {
    throw profileErr(
      'E_PROFILE_KEY_INVALID',
      `profile key "${key}" does not match the required format`,
      { details: { key, pattern: CALLER_KEY_RE.source } },
    );
  }
}

/**
 * The canonical stored key for a persistent or template-promoted profile:
 * `t:<tenantId>/a:<appId>/<callerKey>`. `DB constraint UNIQUE (tenant_id,
 * app_id, key)`, not `UNIQUE (tenant_id, key)`: without `app_id` two apps
 * in one tenant keying by the same end user id would collide on the same
 * directory and cookies, a silent cross app session leak.
 */
export function storedKeyFor(tenantId: string, appId: string, callerKey: string): string {
  return `t:${tenantId}/a:${appId}/${callerKey}`;
}

/**
 * The synthesised key for an ephemeral profile: `eph:<instanceId>`, so no
 * caller code path branches on a null key.
 */
export function ephemeralCallerKey(instanceId: string): string {
  return `eph:${instanceId}`;
}
