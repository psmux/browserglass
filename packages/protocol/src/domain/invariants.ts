/**
 * The 25 runtime checkable invariants, one named exported function per `INV-*` id, so `bgls doctor
 * --check-invariants` and dev build assertions share a single
 * implementation. Each function returns `true` when the invariant holds.
 *
 * Tier A functions are cheap enough to assert on every mutation in dev
 * builds (and behind `BGLS_ASSERT=1` in production). Tier B functions are
 * for the reconciliation loop and `bgls doctor`, run every
 * `reconcileIntervalMs`. Tier C functions are protocol level, checked
 * client side plus by the conformance suite.
 */

import type {
  Attachment,
  ControlLease,
  Instance,
  Node,
  Profile,
  QuotaLimits,
  Session,
  SessionRow,
  Stream,
  Target,
  TargetId,
  ViewerId,
} from './entities.js';

// ── Tier A ──────────────────────────────────────────────────────────────

/** INV-1. A Profile has at most one live lease holder, `count(profiles where lease.holderInstanceId=X) <= 1` for every instance X. */
export function invProfileLeaseUnique(profiles: readonly Profile[]): boolean {
  const seen = new Set<string>();
  for (const p of profiles) {
    const holder = p.lease?.holderInstanceId;
    if (!holder) continue;
    if (seen.has(holder)) return false;
    seen.add(holder);
  }
  return true;
}

/** INV-2. A Target has at most one ControlLease in `granted`/`renewing`/`expiring`, and that lease's holder is a live viewer in the session. */
export function invControlLeaseHolderIsLiveViewer(
  leases: ReadonlyMap<TargetId, ControlLease>,
  liveViewerIds: ReadonlySet<ViewerId>,
): boolean {
  for (const lease of leases.values()) {
    if (lease.state !== 'granted' && lease.state !== 'renewing' && lease.state !== 'expiring')
      continue;
    if (lease.holderViewerId && !liveViewerIds.has(lease.holderViewerId)) return false;
  }
  return true;
}

/** INV-3. A ControlLease holder is always a Viewer of the same Session. */
export function invControlLeaseHolderInSession(
  lease: ControlLease,
  sessionViewerIds: ReadonlySet<ViewerId>,
): boolean {
  return lease.holderViewerId === null || sessionViewerIds.has(lease.holderViewerId);
}

/** INV-4. Every Stream references a Target that exists in the instance's target registry and is `streamable`. */
export function invStreamTargetStreamable(
  stream: Stream,
  targets: ReadonlyMap<TargetId, Target>,
): boolean {
  const target = targets.get(stream.targetId);
  return target?.streamable === true;
}

/** INV-5. Viewer count is never negative and equals the live viewer map size. */
export function invViewerCountMatchesMap(viewerMapSize: number, cachedCount: number): boolean {
  return viewerMapSize >= 0 && viewerMapSize === cachedCount;
}

/** INV-6. `seq` is strictly monotonic per Stream, never resets, including across a quality change. */
export function invSeqMonotonic(nextSeq: number, lastSeq: number): boolean {
  return nextSeq > lastSeq;
}

/** INV-7. `Attachment.backlog >= 0`, and equals `lastSentSeq - lastAckedSeq` when nothing has been skipped. */
export function invAttachmentBacklogConsistent(
  attachment: Attachment,
  framesSkippedSinceLastAck: number,
): boolean {
  if (attachment.backlog < 0) return false;
  if (framesSkippedSinceLastAck > 0) return true;
  return attachment.backlog === attachment.lastSentSeq - attachment.lastAckedSeq;
}

/**
 * INV-8. A binary header `streamId` (the wire handle) is unique within a
 * Viewer's socket and never reused. Restated per viewer socket rather than
 * per session: `Viewer.nextStreamId` only increments, and
 * retired ids are kept in a set so a late frame referencing one is
 * rejected rather than silently colliding with a fresh allocation.
 */
export function invWireStreamIdNeverReused(
  retiredWireIds: ReadonlySet<number>,
  candidateWireId: number,
): boolean {
  return !retiredWireIds.has(candidateWireId);
}

/** INV-9. An Attachment's `viewerId` and `streamId` both resolve within the same Session. */
export function invAttachmentResolvesInSession(
  attachment: Attachment,
  sessionViewerIds: ReadonlySet<ViewerId>,
  sessionStreamIds: ReadonlySet<string>,
): boolean {
  return sessionViewerIds.has(attachment.viewerId) && sessionStreamIds.has(attachment.streamId);
}

/** INV-10. An Instance in `ready` has a non null `nodeId` and a non null `sessionId`. */
export function invReadyInstanceHasNodeAndSession(instance: Instance): boolean {
  if (instance.state !== 'ready') return true;
  return instance.nodeId !== null && instance.sessionId !== null;
}

// ── Tier B ──────────────────────────────────────────────────────────────

/** INV-11. Every Instance in `ready`/`degraded`/`recovering` is claimed by exactly one Node in its inventory report. */
export function invInstanceClaimedByExactlyOneNode(
  liveInstanceIds: readonly string[],
  nodeInventoryInstanceIds: readonly string[],
): boolean {
  const inventorySet = new Set(nodeInventoryInstanceIds);
  const liveSet = new Set(liveInstanceIds);
  if (liveSet.size !== liveInstanceIds.length) return false;
  for (const id of liveInstanceIds) if (!inventorySet.has(id)) return false;
  for (const id of nodeInventoryInstanceIds) if (!liveSet.has(id)) return false;
  return true;
}

/** INV-12. Every Profile in `leased` has a `holderInstanceId` referring to an Instance in a non terminal state. */
export function invLeasedProfileHolderNonTerminal(
  profile: Profile,
  holderInstanceState: Instance['state'] | null,
): boolean {
  if (profile.state !== 'leased') return true;
  return (
    holderInstanceState !== null &&
    holderInstanceState !== 'released' &&
    holderInstanceState !== 'failed'
  );
}

/** INV-13. A Profile's `fence` never decreases across observations. */
export function invProfileFenceNeverDecreases(
  previousFence: number,
  currentFence: number,
): boolean {
  return currentFence >= previousFence;
}

/** INV-14. An Instance's `fence` never decreases, and equals its Profile lease's fence when holding one. */
export function invInstanceFenceConsistent(
  previousFence: number,
  currentFence: number,
  leaseFence: number | null,
): boolean {
  if (currentFence < previousFence) return false;
  if (leaseFence === null) return true;
  return currentFence === leaseFence;
}

/** INV-15. The sum of live instances per tenant is at most `quotas.maxInstances`. */
export function invTenantInstanceCountWithinQuota(
  liveInstanceCount: number,
  quotas: QuotaLimits,
): boolean {
  return liveInstanceCount <= quotas.maxInstances;
}

/** INV-16. No Node in `ready` has `lastHeartbeatAt` older than `nodeLeaseTtlMs`. */
export function invNoStaleReadyNode(node: Node, now: number, nodeLeaseTtlMs: number): boolean {
  if (node.state !== 'ready') return true;
  return now - node.lastHeartbeatAt <= nodeLeaseTtlMs;
}

/** INV-17. Every Session row in `live` has a corresponding in memory Session on the node named by `nodeId`. */
export function invLiveSessionRowHasMemorySession(
  row: SessionRow,
  inMemorySession: Session | null,
): boolean {
  if (row.state !== 'live') return true;
  return inMemorySession !== null && inMemorySession.nodeId === row.nodeId;
}

/** INV-18. Total profile bytes per tenant is at most `quotas.maxProfileBytes`, within one measurement interval's slack. */
export function invTenantProfileBytesWithinQuota(
  totalProfileBytes: number,
  quotas: QuotaLimits,
): boolean {
  return totalProfileBytes <= quotas.maxProfileBytes;
}

/** INV-19. Every `released` Instance has `releasedAt` set and holds no profile lease. */
export function invReleasedInstanceClean(instance: Instance, stillHoldsLease: boolean): boolean {
  if (instance.state !== 'released') return true;
  return instance.releasedAt !== null && !stillHoldsLease;
}

/** INV-20. No two Nodes report `hostsProfiles` containing the same persistent key unless the Profile's `replicaNodeIds` lists both. */
export function invNoDuplicateProfileHomeUnlessReplicated(
  nodesHostingKey: readonly Node[],
  replicaNodeIds: readonly string[],
): boolean {
  if (nodesHostingKey.length <= 1) return true;
  const replicaSet = new Set(replicaNodeIds);
  return nodesHostingKey.every((n) => replicaSet.has(n.id));
}

// ── Tier C ──────────────────────────────────────────────────────────────

/** INV-21. Frames for a given stream arrive with strictly increasing `seq` on one socket. Gaps (skipped frames) are legal; reversals are not. */
export function invFrameSeqStrictlyIncreasing(
  previousSeq: number | null,
  incomingSeq: number,
): boolean {
  return previousSeq === null || incomingSeq > previousSeq;
}

/** INV-22. A viewer never receives frames for a stream it has not subscribed to. */
export function invFrameOnlyForSubscribedStream(
  subscribedStreamWireIds: ReadonlySet<number>,
  frameWireId: number,
): boolean {
  return subscribedStreamWireIds.has(frameWireId);
}

/** INV-23. A viewer never receives `control.grant` it did not request, except immediately after a resume that restored a held lease. */
export function invGrantWasRequestedOrResumed(
  requestedTargetIds: ReadonlySet<TargetId>,
  grantedTargetId: TargetId,
  isResumeRestore: boolean,
): boolean {
  return isResumeRestore || requestedTargetIds.has(grantedTargetId);
}

/** INV-24. `welcome` arrives exactly once per socket, before any frame. */
export function invWelcomeOnceBeforeFrames(
  welcomeCount: number,
  framesReceivedBeforeWelcome: number,
): boolean {
  return welcomeCount === 1 && framesReceivedBeforeWelcome === 0;
}

/**
 * INV-25. A close code is always in exactly one canon band, never
 * overlapping. Bands are kept self contained here rather than importing the wire layer's frozen
 * `CloseCode` object, so this module has no dependency on `../wire`'s
 * runtime values (only entity and codec types are imported from wire, and
 * only as types).
 */
export function invCloseCodeInExactlyOneBand(code: number): boolean {
  const bands: readonly [number, number][] = [
    [1000, 1000],
    [1001, 1001],
    [1002, 1002],
    [1006, 1006],
    [1011, 1011],
    [4000, 4099],
    [4100, 4199],
    [4200, 4299],
    [4300, 4399],
    [4400, 4499],
    [4900, 4999],
  ];
  let matches = 0;
  for (const [lo, hi] of bands) if (code >= lo && code <= hi) matches += 1;
  return matches === 1;
}
