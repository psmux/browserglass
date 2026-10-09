/**
 * `@browserglass/router`'s Profile Service: leasing, fencing, quarantine,
 * and the first four steps of the GC eviction ladder.
 */

export { ProfileService, type ProfileServiceOptions } from './ProfileService.js';
export { ProfileServicePortAdapter } from './adapter.js';
export {
  CALLER_KEY_RE,
  RESERVED_KEY_PREFIXES,
  ephemeralCallerKey,
  storedKeyFor,
  validateCallerKey,
} from './keys.js';
export {
  PROFILE_ERROR_TABLE,
  ProfileServiceError,
  notImplemented,
  profileErr,
  type ProfileErrorTableRow,
} from './errors.js';
export * from './types.js';
