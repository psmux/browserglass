'use client';

import type { BrowserGlassClient, LeaseState, ViewerPresence } from '@browserglass/client';
import { useEffect, useRef, useState } from 'react';

/**
 * One other viewer's live cursor, as broadcast on `presence.cursor`.
 *
 * `label` and `colour` are NOT taken from the cursor message. The server
 * does stamp a label on the relay (`ManagedSession.relayCursor` fills it
 * from the sender's presence entry), but `BrowserGlassClient`'s own
 * `presence.cursor` handler drops it and emits `label: ''`, `colour: ''`.
 * Rather than paper over that with a blank pill on screen, this hook joins
 * each cursor against the presence roster by `viewerId`, which is the same
 * source `<ViewerList/>` renders from, so a viewer's cursor and their row
 * in the list always agree on both name and colour.
 *
 * `x`/`y` are in the SENDER's frame space. The sender also puts `fw`/`fh`
 * (the frame dimensions those coordinates were measured against) on the
 * wire, and the client drops those too, so there is nothing here to
 * rescale with. Two viewers watching the same target at the same quality
 * share a frame space and land in the right place; two at different
 * qualities would not. Same filed request.
 */
export interface PresenceCursor {
  viewerId: string;
  targetId: string;
  x: number;
  y: number;
  label: string;
  colour: string;
  /** Wall clock ms when this position arrived, so a cursor nobody has moved in a while can be dropped rather than left hanging on the page forever. */
  at: number;
  /** What the sender was doing, when the sender says. `'move'` for an ordinary hover. */
  action?: string;
}

/** One viewer who is driving a particular target right now. See {@link driversOf}. */
export interface Driver {
  viewerId: string;
  label: string;
  /**
   * This viewer's presence colour, which is the whole reason the lease and
   * the roster have to be joined rather than either one used alone.
   * `LeaseState.holders` deliberately carries no colour (it is a control
   * record, not a presence record), and colour is what ties a driver to
   * their cursor on the canvas and their row in the viewer list. Falls back
   * to a neutral grey for a holder who is not in the roster, which happens
   * for the fraction of a second between a grant and the presence
   * rebroadcast, and for the synthetic viewer the REST control path borrows
   * a lease under.
   */
  colour: string;
  isMe: boolean;
  /** False while this driver's socket is closed and their disconnect grace is still running. They still hold the lease. */
  connected: boolean;
  /**
   * Whether a person or a piece of software is driving this tab.
   *
   * Read off the presence roster, joined by `viewerId`, because that is the
   * only place the answer exists today. `LeaseState.holders` carries no
   * kind of its own (it is a control record: viewerId, label, two
   * timestamps, connected), so a UI that wanted to draw a robot driver
   * differently from a person had nowhere honest to read it from.
   * `ViewerPresence.kind` is the server's own answer, set from the
   * connecting token: a viewer holding the `automation` capability is
   * `'agent'`, everybody else is `'human'`.
   *
   * `'unknown'` is deliberate and is not the same as `'human'`. A holder
   * with no roster entry has two real causes: the fraction of a second
   * between a grant and the presence rebroadcast, and the synthetic viewer
   * the REST control path borrows a lease under, which never appears in
   * presence at all. Guessing `'human'` there would draw a person's badge
   * over a REST caller, which is the exact confusion this field exists to
   * remove. A caller should render an unknown driver as a plain driver and
   * claim nothing about what it is.
   */
  kind: DriverKind;
}

/**
 * What is driving a tab. The first three values are `ViewerPresence.kind`
 * verbatim; `'unknown'` is this layer's own, for a holder the roster does
 * not describe. See {@link Driver.kind}.
 */
export type DriverKind = 'human' | 'agent' | 'service' | 'unknown';

/** Neutral grey for a holder with no presence entry. Not from the presence palette, deliberately: an unknown driver should not borrow somebody else's colour. */
const UNKNOWN_DRIVER_COLOUR = '#7d8590';

/** Return shape of {@link usePresence}. */
export interface UsePresenceResult {
  viewers: ViewerPresence[];
  me: ViewerPresence | null;
  others: ViewerPresence[];
  cursors: Map<string, PresenceCursor>;
}

const EMPTY_VIEWERS: ViewerPresence[] = [];

/**
 * Everyone currently driving one target, in the order the server grants
 * them, longest tenured first.
 *
 * `LeaseState.holders` is the authority. It is complete, it is identical
 * for every recipient, and it is the one field in the shared-control wire
 * shape that answers "who is driving this tab" without ambiguity. The
 * sibling `holderViewerId` cannot be used for this: in `mode: 'shared'` it
 * is a PER RECIPIENT projection reporting only the recipient's own holding,
 * which makes it exactly right for "am I driving" and useless for "who
 * else".
 *
 * `viewers` is joined in for the two things the lease record does not
 * carry: colour (see {@link Driver.colour}) and kind (see
 * {@link Driver.kind}, which is what lets a caller draw a robot driver
 * differently from a person). It is also the fallback source when `lease`
 * is null, which is the window between connecting and the first
 * `control.state`. In that window
 * `ViewerPresence.controlling` still names the drivers, so the UI has
 * something true to show rather than an empty rail that fills in a moment
 * later.
 *
 * Order is deliberately NOT "this viewer first". The driver rail in the
 * demo is a row of three pixel segments, and re-sorting it the moment
 * somebody takes control would make every other driver's segment jump.
 * Grant order is stable and says something useful on its own. Which
 * segment is yours is answered by colour, and on the control badge by the
 * ring drawn around your own dot.
 */
export function driversOf(
  lease: Pick<LeaseState, 'holders'> | null,
  viewers: readonly ViewerPresence[],
  targetId: string,
  myViewerId: string | null,
): Driver[] {
  const rosterOf = (viewerId: string): ViewerPresence | undefined =>
    viewers.find((v) => v.viewerId === viewerId);

  if (lease) {
    return lease.holders.map((h) => {
      const roster = rosterOf(h.viewerId);
      return {
        viewerId: h.viewerId,
        label: h.label,
        colour: roster?.colour ?? UNKNOWN_DRIVER_COLOUR,
        isMe: h.viewerId === myViewerId,
        connected: h.connected,
        // Not defaulted to 'human'. See Driver.kind: a holder missing from
        // the roster is genuinely unknown, and saying otherwise would put a
        // person's mark on a REST caller.
        kind: roster?.kind ?? 'unknown',
      };
    });
  }

  return viewers
    .filter((v) => v.controlling.includes(targetId))
    .map((v) => ({
      viewerId: v.viewerId,
      label: v.label,
      colour: v.colour,
      isMe: v.viewerId === myViewerId,
      // Presence says nothing about a holder's socket, and everyone in the
      // roster is by definition connected, so this branch cannot report
      // otherwise.
      connected: true,
      // This branch reads the roster entry directly, so the kind is always
      // known here.
      kind: v.kind,
    }));
}

/** Who else is here, watching/driving what. */
export function usePresence(client: BrowserGlassClient | null): UsePresenceResult {
  const [viewers, setViewers] = useState<ViewerPresence[]>(() =>
    client ? [...client.presence] : EMPTY_VIEWERS,
  );
  const [cursors, setCursors] = useState<Map<string, PresenceCursor>>(() => new Map());
  /**
   * The roster as of the last `presence.state`, readable from inside the
   * cursor handler without making that handler depend on the `viewers`
   * state (which would re-subscribe both listeners on every roster change,
   * and lose the cursor positions accumulated so far each time).
   */
  const rosterRef = useRef<readonly ViewerPresence[]>(EMPTY_VIEWERS);

  useEffect(() => {
    const initial = client ? [...client.presence] : EMPTY_VIEWERS;
    rosterRef.current = initial;
    setViewers(initial);
    setCursors(new Map());
    if (!client) return;
    const offs = [
      client.on('presence', (ev) => {
        rosterRef.current = ev.viewers;
        setViewers(ev.viewers);
        // A viewer who has left cannot move their cursor again, so their
        // last position would otherwise sit on the page indefinitely,
        // claiming somebody is hovering there who is not in the room.
        // Re-reading label and colour at the same time keeps a renamed or
        // recoloured viewer's cursor in step with their row in the list.
        setCursors((prev) => {
          if (prev.size === 0) return prev;
          const next = new Map<string, PresenceCursor>();
          for (const [viewerId, cursor] of prev) {
            const viewer = ev.viewers.find((v) => v.viewerId === viewerId);
            if (!viewer) continue;
            next.set(viewerId, { ...cursor, label: viewer.label, colour: viewer.colour });
          }
          return next;
        });
      }),
      client.on('cursor', (ev) => {
        setCursors((prev) => {
          const viewer = rosterRef.current.find((v) => v.viewerId === ev.viewerId);
          const next = new Map(prev);
          next.set(ev.viewerId, {
            viewerId: ev.viewerId,
            targetId: ev.targetId,
            x: ev.x,
            y: ev.y,
            label: viewer?.label ?? ev.label,
            colour: viewer?.colour ?? ev.colour,
            at: Date.now(),
            ...(ev.action !== undefined ? { action: ev.action } : {}),
          });
          return next;
        });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client]);

  const me = client ? (viewers.find((v) => v.viewerId === client.viewerId) ?? null) : null;
  const others = client ? viewers.filter((v) => v.viewerId !== client.viewerId) : viewers;

  return { viewers, me, others, cursors };
}
