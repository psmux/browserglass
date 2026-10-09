'use client';

import type { ReactElement } from 'react';
import type { Driver } from '../usePresence.js';
import { cx } from './internal.js';
import type { ControlBadgeProps } from './types.js';

/**
 * The sentence this badge shows for N drivers.
 *
 * The wording changes shape at two, not at one, because that is where the
 * meaning changes: "You are driving" is a statement about the page, "You
 * and 2 others are driving" is a warning about the page. Somebody whose
 * typing is interleaving with two other people's needs to be told there
 * are two other people before they conclude the input is broken.
 *
 * Agents are counted apart from people wherever the count is not one, for
 * the same reason. "3 people are driving" over two colleagues and a script
 * is not a rounding error: a person decides whether to type into a page a
 * colleague is typing into, and decides differently when the other writer
 * is software that will not notice them. The wording says which.
 */
function driversLabel(drivers: readonly Driver[]): string {
  if (drivers.length === 0) return 'Nobody is driving';
  const me = drivers.find((d) => d.isMe);
  if (drivers.length === 1) {
    if (me) return 'You are driving';
    const only = drivers[0]!;
    return only.kind === 'agent' ? `${only.label} (agent) is driving` : `${only.label} is driving`;
  }

  const agents = drivers.filter((d) => d.kind === 'agent').length;
  const people = drivers.length - agents;

  if (me) {
    // Count the OTHER drivers directly rather than subtracting one from a
    // whole-roster tally. The subtraction quietly assumed the viewer
    // reading this badge is a person, and `Driver.kind` comes from
    // `ViewerPresence.kind`, which the gateway sets from a capability
    // (`granted.has('automation')`), not from what the viewer actually is.
    // A human holding an automation-capable token is therefore reported as
    // an agent, and `people - 1` went to -1: the badge rendered "You, -1
    // others and 2 agents are driving" for two people in a shared
    // workspace. Splitting the remainder by kind cannot go negative no
    // matter how any driver, including this one, is classified.
    const rest = drivers.filter((d) => !d.isMe);
    const otherAgents = rest.filter((d) => d.kind === 'agent').length;
    const otherPeople = rest.length - otherAgents;
    if (otherAgents === 0)
      return `You and ${otherPeople} other${otherPeople === 1 ? '' : 's'} are driving`;
    if (otherPeople === 0)
      return `You and ${otherAgents} agent${otherAgents === 1 ? '' : 's'} are driving`;
    return `You, ${otherPeople} other${otherPeople === 1 ? '' : 's'} and ${otherAgents} agent${otherAgents === 1 ? '' : 's'} are driving`;
  }

  if (agents === 0) return `${drivers.length} people are driving`;
  if (people === 0) return `${agents} agent${agents === 1 ? '' : 's'} are driving`;
  return `${people} ${people === 1 ? 'person' : 'people'} and ${agents} agent${agents === 1 ? '' : 's'} are driving`;
}

/** What a driver's dot says on hover. Names the kind only when the roster actually reported one, so an unknown holder is described as a holder and nothing more. */
function driverTitle(d: Driver): string {
  const who = d.isMe ? `${d.label} (you)` : d.kind === 'agent' ? `${d.label} (agent)` : d.label;
  return d.connected
    ? who
    : `${who} (socket dropped, still holds control until their grace runs out)`;
}

/** "You are driving" / "{name} is driving" / "Nobody is driving", plus a countdown near the renewal window. Server lease state only, no local optimism. With `drivers` supplied it counts every concurrent driver instead. */
export function ControlBadge({
  lease,
  myViewerId,
  drivers,
  showMode,
  showAvatar,
  compact,
  className,
}: ControlBadgeProps): ReactElement {
  const holderViewerId = lease?.holderViewerId ?? null;
  const label =
    drivers !== undefined
      ? driversLabel(drivers)
      : holderViewerId === null
        ? 'Nobody is driving'
        : holderViewerId === myViewerId
          ? 'You are driving'
          : `${lease?.holderLabel ?? 'Someone'} is driving`;

  const secondsLeft = lease?.expiresAt
    ? Math.max(0, Math.round((lease.expiresAt - Date.now()) / 1000))
    : null;
  const nearRenewal = secondsLeft !== null && secondsLeft <= 10;

  return (
    <div
      className={cx('bgls-controlbadge', compact && 'bgls-controlbadge-compact', className)}
      data-bgls-part="controlbadge"
      data-bgls-drivers={drivers?.length}
      data-bgls-mode={lease?.mode}
    >
      {showAvatar && drivers === undefined && holderViewerId && (
        <span data-bgls-part="controlbadge-avatar">
          {(lease?.holderLabel ?? '?').slice(0, 1).toUpperCase()}
        </span>
      )}
      {/*
       * One dot per driver, in that driver's own presence colour, which is
       * the same colour their cursor is drawn in and the same one their row
       * in `<ViewerList/>` uses. Three dots is a count anyone reads without
       * counting, and it is the piece that ties "somebody is typing" to a
       * specific pointer moving on the same pane.
       *
       * `data-bgls-driver-kind` carries what is behind each dot. The
       * shipped stylesheet draws an agent's dot as a rounded square rather
       * than a circle, so a row of dots is readable as "two people and a
       * script" before anybody reads the sentence beside it. The attribute
       * is always present, `'unknown'` included, so an app styling this
       * never has to tell "absent" from "not known".
       */}
      {drivers !== undefined && drivers.length > 0 && (
        <span data-bgls-part="controlbadge-drivers">
          {drivers.map((d) => (
            <span
              key={d.viewerId}
              data-bgls-part="controlbadge-driver"
              data-bgls-is-me={d.isMe || undefined}
              data-bgls-disconnected={d.connected ? undefined : true}
              data-bgls-driver-kind={d.kind}
              style={{ backgroundColor: d.colour }}
              title={driverTitle(d)}
            />
          ))}
        </span>
      )}
      <span data-bgls-part="controlbadge-label">{label}</span>
      {showMode && lease?.mode && (
        <span
          data-bgls-part="controlbadge-mode"
          title={
            lease.mode === 'shared'
              ? 'Shared: anyone who asks for control gets it straight away, and several people can drive this tab at once.'
              : 'Exclusive: one driver at a time. Asking for control while somebody else has it puts you in a queue.'
          }
        >
          {lease.mode}
        </span>
      )}
      {nearRenewal && <span data-bgls-part="controlbadge-countdown">{secondsLeft}s</span>}
    </div>
  );
}
