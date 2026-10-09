/**
 * The one place the server converts a control lease into "who is currently
 * driving this target", as a LIST rather than as a single holder.
 *
 * Why this module exists at all, given it is four lines of real logic:
 * shared control (`LeaseMode = 'shared'`) admits
 * N concurrent holders on one target, and the server had FIVE independent
 * places that each spelled out `snapshot.holder?.viewerId === viewerId`
 * inline. Those five are not cosmetic duplicates of one another, they are
 * five different consequences of holdership:
 *
 *   1. `ManagedSession.applyCapabilityShrink()` decides whether a reauth
 *      that dropped `control` has to revoke a lease this viewer holds.
 *   2. `ManagedSession.broadcastPresence()` decides which targets appear in
 *      a viewer's `presence.state.controlling[]`.
 *   3. `ManagedSession.refreshLeaseHolders()` decides which video
 *      attachments get pinned to tier 0 with a floored AIMD level, so the
 *      person actually driving gets the best picture.
 *   4. `ManagedSession.withRestControl()` checks that the synthetic REST
 *      viewer really did win the lease it is about to drive under.
 *   5. `ws/connection.ts`'s `welcome`/`resumed` lease projections.
 *
 * Every one of them is wrong in shared mode if it asks "is this viewer THE
 * holder", and every one of them is right if it asks "is this viewer ONE OF
 * the holders". Routing all five through here means the day
 * `@browserglass/core`'s `Lease` grows its holders collection, exactly one
 * function body changes and all five call sites become correct together,
 * rather than four of them becoming correct and the fifth being found later
 * by a user whose picture quality quietly stayed at the bottom tier while
 * they were driving.
 *
 * This is deliberately NOT a second wire shape. Nothing here is ever sent to
 * a client: `LeaseState`/`LeaseSummary` (`@browserglass/protocol`) remain the
 * only client-visible lease projections, and they stay separate from each
 * other (their own doc comments say so: three types for three scopes is
 * the intended shape).
 */

/**
 * The fields the server actually reads off a holder. Structurally satisfied
 * by `@browserglass/core`'s `LeaseHolder` without importing it, so this
 * module does not have to move in lockstep with the engine's own
 * bookkeeping fields (`priority`, `lastInputAt`, `lastRenewAt`, `connected`),
 * none of which the server has ever needed.
 */
export interface LeaseHolderView {
  readonly viewerId: string;
  readonly label: string;
}

/**
 * The lease fields this module reads. `holders` is optional and typed
 * `readonly LeaseHolderView[] | undefined` because it is the shared-control
 * collection `@browserglass/core` is adding: reading it through an optional
 * property means the server is correct both before and after that lands,
 * without the server ever declaring a shape of its own that could drift
 * from the engine's.
 */
export interface LeaseHoldersSource {
  readonly holder: LeaseHolderView | null;
  readonly holders?: readonly LeaseHolderView[] | undefined;
}

/**
 * Every viewer currently holding `lease`, newest bookkeeping first is NOT
 * promised: order is whatever the engine keeps, and no caller here depends
 * on it.
 *
 * In exclusive mode this is the singular holder wrapped in an array (or an
 * empty array when the lease is unheld), which is exactly the behaviour
 * every call site had before. In shared mode it is the engine's holders
 * collection verbatim. `holder` is still consulted as the fallback rather
 * than being treated as dead once `holders` exists, because an exclusive
 * lease has no reason to maintain two representations of the same fact.
 */
export function leaseHoldersOf(lease: LeaseHoldersSource): readonly LeaseHolderView[] {
  const shared = lease.holders;
  if (shared !== undefined) return shared;
  return lease.holder ? [lease.holder] : [];
}

/**
 * Whether `viewerId` is one of `lease`'s current holders.
 *
 * Note what this does NOT do: it says nothing about whether a given input
 * message may reach CDP. That decision belongs to `resolveInputFencing`
 * (`@browserglass/core`'s `control/fencing.ts`), which fences by `leaseId`
 * rather than by `viewerId` precisely so one driver's in-flight input can be
 * invalidated without touching anybody else's, and which never drops
 * releases (`mouse.up`, `key.up`, `touch.end`, `touch.cancel`) even on a
 * dead lease. A viewerId comparison cannot express either of those rules and
 * must not be used as a stand-in for them.
 */
export function isLeaseHolder(lease: LeaseHoldersSource, viewerId: string): boolean {
  const shared = lease.holders;
  if (shared !== undefined) return shared.some((h) => h.viewerId === viewerId);
  return lease.holder?.viewerId === viewerId;
}
