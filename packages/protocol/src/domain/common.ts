/**
 * Shared scalar aliases used across the domain module. Kept in one place so
 * every entity and Store signature agrees on what a timestamp or an opaque
 * JSON blob looks like.
 */

/**
 * An ISO 8601 UTC timestamp string, millisecond precision, for example
 * "2026-08-22T14:03:11.482Z". Used on Store method signatures and on the
 * row shaped types that mirror a DDL column stored as TEXT. Entities
 * themselves use epoch millisecond numbers; the store layer is
 * responsible for the conversion at the boundary.
 */
export type Iso = string;

/**
 * A loosely typed JSON object, used where a column stores an opaque JSON
 * blob (for example a node's `labels` or a tenant's `policy` column).
 */
export type Json = Record<string, unknown>;
