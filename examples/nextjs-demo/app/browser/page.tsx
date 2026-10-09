'use client';

import type {
  BrowserGlassClient,
  LeaseState,
  TargetSummary,
  ViewerPresence,
} from '@browserglass/client';
import {
  BrowserGlass,
  driversOf,
  useBrowserGlass,
  useConsole,
  useControlLease,
  useInstanceStats,
  useNav,
  useNetwork,
  usePresence,
  useTargets,
} from '@browserglass/react';
import type { Driver } from '@browserglass/react';
import {
  AddressBar,
  ConnectionBanner,
  ControlBadge,
  CursorLayer,
  DebugOverlay,
  RequestControlButton,
  TabStrip,
  ViewerList,
} from '@browserglass/react/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPhase, AgentStatus } from '../../lib/agent-lab';

/**
 * How this viewer is taking part, which is the choice the whole feature
 * exists to offer: "view or view and control", picked freely, with nobody
 * waiting for anybody.
 *
 * It is a POSTURE, not a permission. `'watch'` does not take the `control`
 * capability off the token and does not hide the per pane control button:
 * a watcher who decides they need the wheel takes it from the pane in
 * front of them and is driving on the next click. That is the point of
 * shared mode. What the posture actually decides is whether merely
 * touching a pane makes this viewer a driver of it, which is the
 * difference between joining to look and joining to work.
 */
type Posture = 'watch' | 'drive';

/**
 * Tracks the raw, wire shaped `LeaseState` for one target, live. This
 * exists because the two React integration layers `@browserglass/react`
 * ships are not interchangeable: `useControlLease` returns an already
 * simplified projection (`{hasControl, holder: {viewerId,label}|null,
 * ...}`) meant to drive an app's own custom UI directly, while
 * `<ControlBadge/>`/`<RequestControlButton/>` (the unstyled primitives this
 * page uses) want the full wire `LeaseState` (`holderViewerId`,
 * `mode`, the real `queue` array). `client.leases` (a `ReadonlyMap`) is the
 * one place that shape lives; this hook subscribes to the `'control'`
 * event (fired on any lease change on the session) to stay live.
 */
function useLeaseState(client: BrowserGlassClient | null, targetId: string): LeaseState | null {
  const [lease, setLease] = useState<LeaseState | null>(() => client?.leases.get(targetId) ?? null);
  useEffect(() => {
    if (!client) {
      setLease(null);
      return;
    }
    setLease(client.leases.get(targetId) ?? null);
    return client.on('control', () => {
      setLease(client.leases.get(targetId) ?? null);
    });
  }, [client, targetId]);
  return lease;
}

/** What `POST /api/browser` (or its refresh sibling) returns. */
interface Credentials {
  instanceId: string;
  sessionId: string;
  reused: boolean;
  /**
   * Why the router did not launch. `'sticky'` is the interesting one for
   * this demo: it means the visitor (or the workspace) already had these
   * browsers and got them back. `null` accompanies `reused: false`.
   */
  reuseReason: 'warm' | 'profile-shared' | 'sticky' | 'idempotent' | null;
  /** Which of `POST /api/browser`'s entry paths produced this result. */
  mode: 'solo' | 'workspace' | 'attached';
  /** The shared workspace id this page is collaborating under, or null in solo mode. */
  workspace: string | null;
  wsPath: string;
  token: string;
}

/**
 * The two query parameters this page understands, read once after mount.
 *
 * `?instanceId=` is the older, narrower escape hatch: join exactly this
 * instance, never launch. `?workspace=` is the collaboration model: join
 * whatever browsers this workspace owns, launching them if this is the
 * first person through the door. `null` for the whole object means the
 * query string has not been read yet (`window` does not exist during SSR).
 */
interface PageQuery {
  instanceId: string | null;
  workspace: string | null;
}

/**
 * What the release routes answer with, passed through from
 * `BrowserRouter.release`'s own `ReleaseResult`.
 *
 * `'detached'` is the one that matters here: it means the browsers were
 * NOT killed, because other viewers are still attached. A page that reads
 * only a boolean would announce "closed" over a browser that is still
 * running for two other people, which is why the router stopped returning
 * `void` from `release()` in the first place.
 */
interface ReleaseOutcome {
  released?: boolean;
  outcome?: 'terminated' | 'detached' | 'already_released';
  remainingViewers?: number;
}

/** Colour for one console line, by level. Matches the pane chrome's existing red/amber/green vocabulary (LIVE/POLLING badges) rather than introducing a new palette. */
function consoleLevelColour(level: string): string {
  if (level === 'error') return '#e67e7e';
  if (level === 'warn') return '#e6c37e';
  return '#9aa';
}

/**
 * The agent's own colours, kept together so a robot is one thing on this
 * page rather than a violet border here and a violet pill there.
 *
 * A deliberate fourth hue, next to the console's existing three: LIVE green
 * (a stream is running), POLLING amber (a stream is degraded), accent blue
 * (this is the thing you have selected). None of those could be borrowed
 * without saying something untrue, so software driving a tab gets violet,
 * which is used for nothing else here.
 */
/**
 * What this demo calls its own agent.
 *
 * A name, not a category. The server labels every viewer with its raw
 * `vwr_...` id (presence takes `label: sink.viewerId`), which is honest and
 * unreadable, and `<ControlBadge/>` supplies the "(agent)" part itself from
 * `Driver.kind`. So a label of "Agent" would read "Agent (agent) is
 * driving". A name reads "Scout (agent) is driving", which is a sentence.
 */
const AGENT_NAME = 'Scout';

const AGENT_INK = '#c0a3ff';
const AGENT_GROUND = '#221b36';
const AGENT_EDGE = '#4b3d75';

/**
 * The small amount of CSS this page cannot express inline: two keyframe
 * animations and the reduced-motion escape from both.
 *
 * Everything else on this page is an inline style, and that is fine for
 * static declarations. Keyframes are not expressible that way at all, and
 * an animation that a person cannot switch off is an accessibility defect
 * rather than a flourish, so the media query is not optional decoration.
 */
const AGENT_CSS = `
@keyframes bgls-agent-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
@keyframes bgls-agent-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.bgls-agent-sweep {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
}
.bgls-agent-sweep::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, ${AGENT_INK}, transparent);
  animation: bgls-agent-sweep 1.8s linear infinite;
}
.bgls-agent-breathe {
  animation: bgls-agent-breathe 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .bgls-agent-sweep::after,
  .bgls-agent-breathe {
    animation: none;
  }
}
`;

/**
 * The demo's own agent, polled.
 *
 * Polling rather than a socket subscription, on purpose and not as a
 * shortcut. The agent is this application's program, not a participant in
 * the `bgls.v1` protocol's own vocabulary: the session knows it as a viewer
 * with `kind: 'agent'` and knows nothing about the loop it is running or
 * which sentence of the loop it is on. Everything on the socket that IS
 * protocol (who holds the tab, whose cursor is where, whether the lease
 * moved) still arrives on the socket and is not polled. What is polled is
 * only the narration, and 700ms is fast enough for a sentence a person
 * reads.
 */
function useAgent(instanceId: string | null): {
  status: AgentStatus | null;
  busy: boolean;
  act: (
    action: 'start' | 'standDown' | 'handBack' | 'stop',
    extra?: Record<string, unknown>,
  ) => Promise<void>;
} {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (instanceId === null) {
      setStatus(null);
      return;
    }
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(`/api/browser/agent?instanceId=${encodeURIComponent(instanceId)}`);
        const body = (await r.json()) as { agent: AgentStatus | null };
        if (alive) setStatus(body.agent);
      } catch {
        // A poll that misses is a poll that misses; the next one is 700ms
        // away. Blanking the console because one fetch failed would make
        // the agent look like it had stopped when it had not.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [instanceId]);

  const act = useCallback(
    async (
      action: 'start' | 'standDown' | 'handBack' | 'stop',
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      if (instanceId === null) return;
      setBusy(true);
      try {
        const r = await fetch('/api/browser/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instanceId, action, ...extra }),
        });
        const body = (await r.json()) as { agent?: AgentStatus | null };
        // Applied straight away rather than waiting for the next poll. The
        // whole point of the takeover is that it feels instant, and up to
        // 700ms of a console still reading "Typing:" after the tab has
        // already changed hands would undo that on its own.
        if (body.agent !== undefined) setStatus(body.agent);
      } finally {
        setBusy(false);
      }
    },
    [instanceId],
  );

  return { status, busy, act };
}

/**
 * How long it takes for one viewer to stop holding a target, measured off
 * `control.state` rather than off the agent's own self report.
 *
 * This is the number the demo prints after a takeover, and where it is
 * measured is the whole point. The agent could report its own stand-down,
 * and that number would be flattering and slightly beside the point: it
 * would time the agent's opinion of itself. What a person cares about is
 * when the robot actually stopped holding the tab they are now in, and the
 * authority on that is the lease broadcast every viewer sees.
 *
 * Socket-speed, not poll-speed. The agent's narration is polled at 700ms,
 * so timing the takeover off it would quantise every measurement to the
 * poll interval and could not tell 1ms from 600ms.
 *
 * Resolves `null` on timeout, which is reported as "not seen" rather than
 * as a large number: a measurement that did not happen is not a slow
 * measurement.
 */
function waitForHolderGone(
  client: BrowserGlassClient,
  targetId: string,
  viewerId: string,
  timeoutMs = 8000,
): Promise<number | null> {
  const startedAt = performance.now();
  const stillHolding = (): boolean =>
    (client.leases.get(targetId)?.holders ?? []).some((h) => h.viewerId === viewerId);
  if (!stillHolding()) return Promise.resolve(0);
  return new Promise((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      resolve(value);
    }
    off = client.on('control', () => {
      if (!stillHolding()) finish(Math.round(performance.now() - startedAt));
    });
  });
}

/** What the page itself measured about the last takeover. Distinct from anything the agent says about itself. */
interface TakeoverMeasurement {
  /** Milliseconds from the click to the agent leaving `holders[]`, or null when that was never observed. */
  ms: number | null;
  /** Agent holders this client knew of when it sent `control.yield`, straight from `ControlYieldResult`. */
  agentsAsked: number;
  /** Non-null when the yield was refused before it left this machine. */
  error: string | null;
}

/** The phase pill's words and colours. One place, so the console and the pane strip cannot drift apart. */
function agentPhaseChrome(phase: AgentPhase): { label: string; fg: string; bg: string } {
  if (phase === 'working') return { label: 'DRIVING', fg: AGENT_INK, bg: AGENT_GROUND };
  if (phase === 'starting') return { label: 'CONNECTING', fg: '#e6c37e', bg: '#5c4a1e' };
  if (phase === 'stood-down') return { label: 'STOOD DOWN', fg: '#7db1ff', bg: '#16304f' };
  if (phase === 'error') return { label: 'ERROR', fg: '#e67e7e', bg: '#4a1f1f' };
  return { label: 'OFF', fg: '#9aa', bg: '#22242c' };
}

/**
 * The robot mark. A square, because every other presence mark on this page
 * is a circle: a person's cursor, a person's dot on the control badge, a
 * person's avatar in the viewer list. Round is somebody, square is
 * something.
 */
function AgentMark({ live, size = 30 }: { live: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={live ? 'bgls-agent-breathe' : undefined}
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 6,
        background: AGENT_GROUND,
        border: `1px solid ${AGENT_EDGE}`,
        color: AGENT_INK,
        display: 'grid',
        placeItems: 'center',
        fontSize: Math.round(size * 0.52),
        lineHeight: 1,
      }}
    >
      &#9635;
    </span>
  );
}

/**
 * The agent strip: what software is doing to this browser, in a sentence,
 * with the way to interrupt it next to the sentence.
 *
 * This sits directly under the header rather than inside a pane because it
 * answers a question about the whole wall ("is anything driving itself
 * right now"), and because the button that matters most on this page is in
 * it. Which pane the agent is on is answered on the pane, by the marking
 * there.
 */
function AgentConsole({
  status,
  takeover,
  busy,
  onStart,
  onStop,
  onTakeOver,
  onHandBack,
  tabNumber,
  disabled,
}: {
  status: AgentStatus | null;
  /** What the PAGE measured about the last takeover, off the lease broadcast. Not the agent's own account of itself. */
  takeover: TakeoverMeasurement | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onTakeOver: () => void;
  onHandBack: () => void;
  /** 1-based position of the agent's pane in the grid, for "tab 2". Null before it starts. */
  tabNumber: number | null;
  disabled: boolean;
}) {
  const phase: AgentPhase = status?.phase ?? 'off';
  const chrome = agentPhaseChrome(phase);
  const running = phase === 'working' || phase === 'starting';

  return (
    <section
      aria-label="Agent"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 14px',
        background: '#14121c',
        border: `1px solid ${AGENT_EDGE}`,
        borderLeft: `3px solid ${AGENT_INK}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <AgentMark live={phase === 'working'} />

      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.16em',
          color: AGENT_INK,
        }}
      >
        AGENT
      </span>

      <span style={{ fontSize: 12, fontWeight: 600, color: '#e8e8ea', whiteSpace: 'nowrap' }}>
        {AGENT_NAME}
      </span>

      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          padding: '2px 7px',
          borderRadius: 4,
          color: chrome.fg,
          background: chrome.bg,
          whiteSpace: 'nowrap',
        }}
      >
        {chrome.label}
      </span>

      {/*
       * The narration. Monospace and a fixed minimum width because it
       * changes several times a second while the agent works, and a
       * proportional string that reflows the whole row on every change is
       * harder to read than the same string held still.
       */}
      <span
        aria-live="polite"
        style={{
          flex: '1 1 260px',
          minWidth: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          color: phase === 'error' ? '#e67e7e' : '#c8ccd4',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {phase === 'off'
          ? 'Nothing is driving itself. Start it and watch a browser work while you sit there.'
          : (status?.error ?? status?.step ?? '')}
      </span>

      {status !== null && phase !== 'off' && (
        <span style={{ fontSize: 11, color: '#667', whiteSpace: 'nowrap' }}>
          {tabNumber !== null ? `tab ${tabNumber} · ` : ''}
          {status.cycles} {status.cycles === 1 ? 'loop' : 'loops'}
          {takeover !== null && takeover.error === null
            ? takeover.ms === null
              ? ' · never saw it let go'
              : ` · let go in ${takeover.ms}ms`
            : ''}
        </span>
      )}

      {phase === 'working' && (
        <button
          type="button"
          onClick={onTakeOver}
          disabled={busy}
          title="Take the tab off the agent. You get control immediately; the agent is told to stop and stops mid keystroke."
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '6px 14px',
            border: '1px solid #7db1ff',
            borderRadius: 6,
            background: '#16304f',
            color: '#cfe3ff',
            cursor: busy ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Take control
        </button>
      )}

      {phase === 'stood-down' && (
        <button
          type="button"
          onClick={onHandBack}
          disabled={busy}
          title="Give the tab back. The agent picks up where its loop left off."
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '6px 14px',
            border: `1px solid ${AGENT_EDGE}`,
            borderRadius: 6,
            background: AGENT_GROUND,
            color: AGENT_INK,
            cursor: busy ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Hand the tab back
        </button>
      )}

      {phase === 'off' || phase === 'error' ? (
        <button
          type="button"
          onClick={onStart}
          disabled={busy || disabled}
          style={{ fontSize: 12, padding: '5px 12px', whiteSpace: 'nowrap' }}
        >
          Start the agent
        </button>
      ) : (
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          style={{ fontSize: 12, padding: '5px 12px', whiteSpace: 'nowrap' }}
        >
          Stop
        </button>
      )}

      {/*
       * A yield refused before it left the machine. `yieldControl()` decides
       * both of the server's failure paths locally and throws, so this is
       * the one case where a person clicked "Take control" and no message
       * was sent at all. Silence there would be the worst outcome.
       */}
      {takeover?.error != null && (
        <span style={{ flexBasis: '100%', fontSize: 11, color: '#e67e7e' }}>
          The stand-down was refused before it was sent: {takeover.error}
        </span>
      )}

      {/* A sweep, not a spinner. A spinner says "wait for me"; this says
          "something is still running", which is the true statement. */}
      {running && <span className="bgls-agent-sweep" aria-hidden="true" />}
    </section>
  );
}

/**
 * What the agent's own pane says, under its control badge.
 *
 * The console above is where the agent is explained; this is where it is
 * ACTED ON, next to the thing being acted on. Somebody who has watched the
 * middle pane type by itself for ten seconds and wants it to stop looks at
 * the middle pane, not at a strip above three panes.
 */
function AgentPaneStrip({
  status,
  takeover,
  holdingNow,
  busy,
  onTakeOver,
  onHandBack,
}: {
  status: AgentStatus;
  /** The page's own measurement of the last takeover, or null when there has not been one since the agent was handed back. */
  takeover: TakeoverMeasurement | null;
  /**
   * Whether a robot holds this tab's lease AT THIS INSTANT, off
   * `LeaseState.holders`.
   *
   * Not the same question as `status.phase === 'working'`, and the
   * difference is visible: the agent lets go of the lease between loops,
   * and its narration is polled at 700ms while the lease arrives on the
   * socket. Wording this off the poll produced "Scout is driving this tab"
   * next to a badge reading "Nobody is driving", which is the app
   * contradicting the wire. The wire wins.
   */
  holdingNow: boolean;
  busy: boolean;
  onTakeOver: () => void;
  onHandBack: () => void;
}) {
  if (status.phase === 'working' || status.phase === 'starting') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 8px',
          fontSize: 11,
          color: AGENT_INK,
          background: '#191426',
          borderTop: `1px solid ${AGENT_EDGE}`,
        }}
      >
        <AgentMark live={holdingNow} size={16} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {holdingNow
            ? `${AGENT_NAME} is driving this tab.`
            : `${AGENT_NAME} has this tab. Between actions right now.`}
        </span>
        <button
          type="button"
          onClick={onTakeOver}
          disabled={busy}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '3px 10px',
            border: '1px solid #7db1ff',
            borderRadius: 4,
            background: '#16304f',
            color: '#cfe3ff',
            cursor: busy ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Take over
        </button>
      </div>
    );
  }

  if (status.phase === 'stood-down') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 8px',
          fontSize: 11,
          color: '#9ec5ff',
          background: '#101a28',
          borderTop: '1px solid #2a3c55',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          {AGENT_NAME} let go
          {takeover?.ms != null ? ` in ${takeover.ms}ms` : ''}. This tab is yours.
        </span>
        <button
          type="button"
          onClick={onHandBack}
          disabled={busy}
          style={{
            fontSize: 11,
            padding: '3px 10px',
            border: `1px solid ${AGENT_EDGE}`,
            borderRadius: 4,
            background: AGENT_GROUND,
            color: AGENT_INK,
            cursor: busy ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Hand back
        </button>
      </div>
    );
  }

  return null;
}

/**
 * Renames the one driver this demo itself started.
 *
 * This app knows something the server does not: which viewer id belongs to
 * the agent it launched a moment ago. So it names that one and leaves every
 * other label exactly as the server sent it, rather than inventing names
 * for people.
 *
 * `kind` is NOT rewritten here. It comes off the presence roster, which is
 * the server's own answer, and a driver whose kind is `'agent'` is drawn as
 * software whether or not this app recognises the id. That is the whole
 * point of reading it from the wire: a SECOND agent, started by somebody
 * else, is still marked as one here without this app knowing anything about
 * it.
 */
function withAgentLabels(drivers: readonly Driver[], agentViewerId: string | null): Driver[] {
  return drivers.map((d) =>
    d.viewerId === agentViewerId && agentViewerId !== null ? { ...d, label: AGENT_NAME } : d,
  );
}

/**
 * The two modes, side by side, as one control.
 *
 * Deliberately a pair of visible buttons rather than a checkbox or a
 * dropdown. Both options have to be readable without opening anything,
 * because the question this answers ("can the person at that other desk
 * change what I am looking at") is the first thing anybody asks about a
 * shared browser, and an unexpanded dropdown answers it for one of the two
 * states only.
 */
function PostureSwitch({
  posture,
  onChange,
  disabled,
}: {
  posture: Posture;
  onChange: (next: Posture) => void;
  disabled: boolean;
}) {
  const options: Array<{ value: Posture; label: string; title: string }> = [
    {
      value: 'watch',
      label: 'Watch',
      title:
        'See everything, change nothing. Your cursor is still visible to everyone else, so people can follow what you are pointing at. Taking control of any one tab is still one click away.',
    },
    {
      value: 'drive',
      label: 'Watch and control',
      title:
        'Touching a tab makes you one of its drivers straight away. In shared mode nobody is queued and nobody loses control: everyone already driving keeps driving.',
    },
  ];
  return (
    // A real `<fieldset>` rather than a div carrying `role="group"`: the two
    // buttons are one choice, and a screen reader should hear the question
    // ("How you are taking part") before either answer.
    <fieldset
      style={{
        display: 'inline-flex',
        border: '1px solid #2a2c33',
        borderRadius: 6,
        overflow: 'hidden',
        margin: 0,
        padding: 0,
      }}
    >
      <legend
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        How you are taking part
      </legend>
      {options.map((o) => {
        const selected = posture === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={disabled}
            aria-pressed={selected}
            title={o.title}
            style={{
              fontSize: 12,
              fontWeight: selected ? 600 : 400,
              padding: '5px 12px',
              border: 'none',
              cursor: disabled ? 'default' : 'pointer',
              background: selected ? '#1e5c2c' : 'transparent',
              color: selected ? '#7ee69a' : '#9aa',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * A three pixel bar under a pane's header, split into one segment per
 * driver, each in that driver's own presence colour.
 *
 * The badge underneath says the same thing in words, and the words are
 * slower. Four panes, glanced at across a desk, are four rails: an empty
 * grey line means nobody has that tab, one green segment means one person
 * does, two segments means two people are typing into the same page right
 * now and their characters are interleaving. That last state is the one
 * this demo exists to make obvious, and it is legible before anybody reads
 * anything.
 */
function DriverRail({ drivers }: { drivers: readonly Driver[] }) {
  if (drivers.length === 0) {
    return <div style={{ height: 4, background: '#22242c' }} aria-hidden="true" />;
  }
  return (
    <div style={{ display: 'flex', height: 4 }} aria-hidden="true">
      {drivers.map((d) => (
        <div
          key={d.viewerId}
          title={
            d.connected
              ? d.isMe
                ? `${d.label} (you) is driving this tab`
                : d.kind === 'agent'
                  ? `${d.label} is software, and it is driving this tab`
                  : `${d.label} is driving this tab`
              : `${d.label} still holds this tab, but their connection has dropped`
          }
          style={{
            flex: 1,
            // Solid is a person, dashed is software. Keeping the driver's
            // own presence colour in both cases is what ties a segment to a
            // cursor on the canvas, so the difference has to be carried by
            // something other than hue. `kind` comes off the presence
            // roster; a holder the roster does not describe (`'unknown'`)
            // is drawn solid, because claiming otherwise would be inventing
            // an answer.
            background:
              d.kind === 'agent'
                ? `repeating-linear-gradient(115deg, ${d.colour} 0 4px, #0d0f14 4px 8px)`
                : d.colour,
            // Faded, not removed. A driver in their disconnect grace has not
            // given anything up yet, and taking their segment away would say
            // the tab is freer than it is.
            opacity: d.connected ? 1 : 0.35,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Who this browser window is, in this session's own colour vocabulary.
 *
 * The demo is meant to be opened twice, side by side, and driven from
 * both. Without this, the two windows are identical and there is no way to
 * tell which of the two coloured cursors on the screen is the one being
 * moved by the hand on the mouse. The colour comes from the server
 * (`presence.state.colour`, stable per viewer for the life of the session)
 * and is the same one used for this viewer's cursor, their dot on every
 * control badge, and their segment of every driver rail.
 */
function IdentityChip({ me }: { me: ViewerPresence | null }) {
  if (!me) return null;
  return (
    <span
      title="Your name and colour in this session. Everyone else sees your cursor in this colour."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9aa' }}
    >
      <span
        style={{ width: 10, height: 10, borderRadius: '50%', background: me.colour, flex: 'none' }}
      />
      You are {me.label}
    </span>
  );
}

/**
 * One pane's cursor overlay, with its own presence subscription.
 *
 * The subscription is here, rather than the page passing its cursor map
 * down, for one reason: cursor positions arrive at roughly 25 a second per
 * moving viewer, and a new map on the page's own state would re-render
 * every pane, every address bar, and every `<BrowserGlass/>` in the grid on
 * each one. Subscribing inside the overlay confines that rate to the one
 * component whose output actually changes at it. `usePresence` is cheap to
 * mount more than once: it adds two listeners to an emitter the client
 * already owns and holds no socket of its own.
 *
 * Rendered through `<BrowserGlass overlay={...}>` because `toClient`, the
 * pane renderer's frame-to-screen mapping with this canvas's letterboxing
 * and scale already applied, exists nowhere else.
 */
function PaneCursors({
  client,
  targetId,
  myViewerId,
  drivingViewerIds,
  toClient,
}: {
  client: BrowserGlassClient;
  targetId: string;
  myViewerId: string | null;
  drivingViewerIds: readonly string[];
  toClient: (x: number, y: number) => { clientX: number; clientY: number };
}) {
  const presence = usePresence(client);
  return (
    <CursorLayer
      cursors={presence.cursors.values()}
      targetId={targetId}
      myViewerId={myViewerId}
      toClient={toClient}
      drivingViewerIds={drivingViewerIds}
    />
  );
}

/**
 * One pane's console/error/network readout, collapsed by default. This is
 * itself the per target opt in the diagnostics feature requires
 * (a wall of 12 panes must not pay for Network.enable on all of them
 * by default): both hooks are always
 * mounted (React's own rule, hooks cannot be called conditionally), but
 * subscribe: expanded means the wire diagnostics.subscribe call, and
 * everything CDP side it triggers, only happens for a pane whose panel is
 * actually open. Rendered per Pane, not as one shared panel, so several
 * panes' diagnostics can be open and updating at once, which is the whole
 * point.
 */
function DiagnosticsPanel({ client, targetId }: { client: BrowserGlassClient; targetId: string }) {
  const [expanded, setExpanded] = useState(false);
  const consoleHook = useConsole(client, targetId, { subscribe: expanded });
  const networkHook = useNetwork(client, targetId, { subscribe: expanded });

  return (
    <div style={{ borderTop: '1px solid #2a2c33', background: '#0d0f14' }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{
          width: '100%',
          textAlign: 'left',
          fontSize: 11,
          padding: '4px 8px',
          background: 'transparent',
          border: 'none',
          color: '#9aa',
          cursor: 'pointer',
        }}
      >
        {expanded ? 'Hide' : 'Show'} diagnostics
        {!expanded && (consoleHook.entries.length > 0 || networkHook.entries.length > 0)
          ? ` (console ${consoleHook.entries.length}, network ${networkHook.entries.length})`
          : ''}
      </button>
      {expanded && (
        <div
          style={{
            maxHeight: 180,
            overflowY: 'auto',
            padding: '0 8px 8px',
            fontFamily: 'monospace',
            fontSize: 11,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              color: '#7db1ff',
              margin: '4px 0 2px',
            }}
          >
            <span>Console ({consoleHook.entries.length})</span>
            <button
              type="button"
              onClick={consoleHook.clear}
              style={{ fontSize: 10, padding: '1px 6px' }}
            >
              clear
            </button>
          </div>
          {consoleHook.entries.length === 0 && (
            <div style={{ color: '#556' }}>No console output yet.</div>
          )}
          {consoleHook.entries.map((entry, i) => (
            <div
              key={`${entry.receivedAt}-${i}`}
              style={{
                color: consoleLevelColour(entry.level),
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              [{entry.level}] {entry.text}
            </div>
          ))}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              color: '#7db1ff',
              margin: '8px 0 2px',
            }}
          >
            <span>Network ({networkHook.entries.length})</span>
            <button
              type="button"
              onClick={networkHook.clear}
              style={{ fontSize: 10, padding: '1px 6px' }}
            >
              clear
            </button>
          </div>
          {networkHook.entries.length === 0 && (
            <div style={{ color: '#556' }}>No requests yet.</div>
          )}
          {networkHook.entries.map((row, i) => (
            <div
              key={`${row.receivedAt}-${i}`}
              style={{
                color: row.errorText || (row.status ?? 0) >= 400 ? '#e67e7e' : '#9ab',
                wordBreak: 'break-all',
              }}
            >
              {row.method} {row.status ?? row.errorText ?? '...'} {row.url}
              {row.durationMs !== null ? ` (${Math.round(row.durationMs)}ms)` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One target's pane: the streamed canvas plus the per target chrome that
 * actually needs that target's own id (address bar, control badge,
 * diagnostics panel). This is the file's only sub component besides
 * DiagnosticsPanel, justified by the grid itself: the layout is "one
 * <BrowserGlass client targetId /> per target", so every pane repeats the
 * same handful of hooks scoped to a different targetId.
 */
function Pane({
  client,
  target,
  focused,
  onFocus,
  myViewerId,
  viewers,
  posture,
  onExpand,
  expanded,
  agent,
  agentTakeover,
  agentBusy,
  onAgentTakeOver,
  onAgentHandBack,
  onControlError,
}: {
  client: BrowserGlassClient;
  target: TargetSummary;
  focused: boolean;
  onFocus: () => void;
  myViewerId: string | null;
  /** The whole presence roster. This pane works out its own drivers from it; see `driversOf`. */
  viewers: readonly ViewerPresence[];
  posture: Posture;
  onExpand: () => void;
  /**
   * True while this same target is open in the full size modal. The pane
   * renders a placeholder instead of its own `<BrowserGlass/>` while
   * expanded, rather than mounting a second one for the same target: two
   * live `<BrowserGlass/>` components sharing one `client.subscribe()`
   * handle (`@browserglass/client`'s dedup returns the same handle to both
   * callers, see `BrowserGlassClient.subscribe()`) would race on
   * `unsubscribe()` when either one unmounts, since that call is not
   * reference counted and tears the shared stream down unconditionally.
   * One target, one mounted `<BrowserGlass/>`, is the simple invariant
   * that avoids the whole class of bug.
   */
  expanded: boolean;
  /**
   * The demo's agent, when this is the tab it drives. `null` on every other
   * pane, which is what keeps the robot marking on exactly one of them.
   */
  agent: AgentStatus | null;
  /** The page's own takeover measurement, passed through to the strip. Null on every pane but the agent's. */
  agentTakeover: TakeoverMeasurement | null;
  agentBusy: boolean;
  onAgentTakeOver: () => void;
  onAgentHandBack: () => void;
  /**
   * A control request or release this pane sent that came back rejected.
   * `useControlLease().request()`/`.release()` reject on a real server
   * refusal (a policy denial, a fenced token, a target that no longer
   * exists), and a click that produces no visible change and no console
   * line reads as a broken button rather than a refusal with a reason.
   * Threaded up rather than shown inline, so it lands in the same `notice`
   * line every other page level message uses.
   */
  onControlError: (message: string) => void;
}) {
  const nav = useNav(client, target.targetId);
  const leaseHook = useControlLease(client, target.targetId);
  const leaseState = useLeaseState(client, target.targetId);
  // `leaseState` first, presence second: `LeaseState.holders` is the
  // authority on who is driving this tab, and presence only fills the
  // window before the first `control.state` lands. See `driversOf`.
  const drivers = withAgentLabels(
    driversOf(leaseState, viewers, target.targetId, myViewerId),
    agent?.viewerId ?? null,
  );
  const iAmDriving = drivers.some((d) => d.isMe);
  const drivingViewerIds = drivers.map((d) => d.viewerId);
  /**
   * True when a robot is one of the current holders of THIS tab, read off
   * the lease and the roster rather than off the agent's own self report.
   * The two can disagree for a moment (the agent releases before the next
   * `control.state` lands) and the wire is the one to believe.
   */
  const agentIsDriving = drivers.some((d) => d.kind === 'agent' && d.connected);
  const isAgentTab = agent !== null && agent.phase !== 'off';

  return (
    <div
      onPointerDownCapture={onFocus}
      style={{
        border: focused
          ? '2px solid #7db1ff'
          : agentIsDriving
            ? `2px solid ${AGENT_EDGE}`
            : '2px solid #2a2c33',
        borderRadius: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: '#111318',
      }}
      data-pane-target-id={target.targetId}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          background: '#181a20',
        }}
      >
        <span
          title={
            target.active
              ? 'Live: this target is the active tab of its own Chrome window, so it streams continuous video. With the demo pool at isolation: window every pane gets its own window, so every pane can be live at the same time and driving one never freezes another.'
              : 'Polling: this target shares a window with another tab that is currently the visible one, so it updates from periodic screenshots rather than continuous video. Chromium composites only the visible tab of any given window. Click it to promote it.'
          }
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 6px',
            borderRadius: 4,
            background: target.active ? '#1e5c2c' : '#5c4a1e',
            color: target.active ? '#7ee69a' : '#e6c37e',
            whiteSpace: 'nowrap',
          }}
        >
          {target.active ? 'LIVE' : 'POLLING'}
        </span>
        {/*
         * Next to LIVE/POLLING, because it answers the same kind of
         * question about the same pane: that one is streaming, this one is
         * being driven by software. Present whenever the agent is on this
         * tab, including while it is stood down, so the pane does not
         * silently stop being the agent's tab the moment somebody takes it.
         */}
        {isAgentTab && (
          <span
            title={
              agentIsDriving
                ? 'An agent holds control of this tab right now.'
                : 'This is the agent’s tab. It is not holding control at the moment.'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 4,
              background: agentIsDriving ? AGENT_GROUND : '#1a1c24',
              color: agentIsDriving ? AGENT_INK : '#7a7f8c',
              border: `1px solid ${agentIsDriving ? AGENT_EDGE : '#2a2c33'}`,
              whiteSpace: 'nowrap',
            }}
          >
            <AgentMark live={agentIsDriving} size={12} />
            AGENT
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <AddressBar
            url={nav.url}
            loading={nav.loading}
            canGoBack={nav.canGoBack}
            canGoForward={nav.canGoForward}
            canNavigate={nav.canNavigate}
            securityState={nav.securityState}
            onNavigate={nav.goto}
            onBack={nav.back}
            onForward={nav.forward}
            onReload={() => nav.reload()}
            onStop={nav.stop}
            blocked={nav.blocked}
            onDismissBlocked={nav.dismissBlocked}
          />
        </div>
        <button
          type="button"
          onClick={onExpand}
          title="Open full size and drive it in a modal"
          style={{ fontSize: 12, padding: '4px 8px', whiteSpace: 'nowrap' }}
        >
          Expand
        </button>
      </div>
      <DriverRail drivers={drivers} />
      <div style={{ position: 'relative', aspectRatio: '16 / 10' }}>
        {expanded ? (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#9aa',
              fontSize: 13,
              textAlign: 'center',
              padding: 12,
            }}
          >
            Open full size below. Only one live view per tab at a time.
          </div>
        ) : (
          <BrowserGlass
            client={client}
            targetId={target.targetId}
            fit="contain"
            // `'onInteract'` is what "control immediately if needed"
            // actually looks like in a grid: touch a pane and it is yours,
            // with no button pressed first and, in shared mode, nobody
            // dislodged. `'onMount'` would be worse rather than more
            // eager, because it would make every viewer a driver of all
            // three tabs the moment they opened the page, including the
            // ones who came to watch.
            autoControl={posture === 'drive' ? 'onInteract' : 'never'}
            // Left interactive even for a watcher, which looks wrong and
            // is not. Cursor presence has no transport of its own: the
            // client publishes `presence.cursor` off the back of the
            // `input.mouse` moves `InputCapture` is already sending
            // (`BrowserGlassClient.sendInput`), so a pane with input
            // capture switched off publishes no cursor and a watcher
            // becomes invisible to the room. The input itself changes
            // nothing: with no lease, `resolveInputFencing` drops every
            // press, key, and wheel event server side before it reaches
            // CDP. Releases are the documented exception and are dispatched
            // anyway, which is the behaviour that stops a departing driver
            // leaving a mouse button stuck down for everybody else.
            interactive
            overlay={({ toClient }) => (
              <PaneCursors
                client={client}
                targetId={target.targetId}
                myViewerId={myViewerId}
                drivingViewerIds={drivingViewerIds}
                toClient={toClient}
              />
            )}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        )}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 8px',
          background: '#181a20',
        }}
      >
        <ControlBadge
          lease={leaseState}
          myViewerId={myViewerId}
          drivers={drivers}
          showMode
          compact
        />
        <RequestControlButton
          lease={leaseState}
          myViewerId={myViewerId}
          canRequest={leaseHook.canRequest}
          requesting={leaseHook.requesting}
          iAmDriving={iAmDriving}
          onRequest={() =>
            void leaseHook
              .request()
              .catch((err) => onControlError(err instanceof Error ? err.message : String(err)))
          }
          onRelease={() =>
            void leaseHook
              .release()
              .catch((err) => onControlError(err instanceof Error ? err.message : String(err)))
          }
        />
      </div>
      {/*
       * Said plainly, and only when it is actually happening. Two people
       * typing into the same focused input interleave their characters,
       * and that is inherent to control without a queue, not a defect to
       * be smoothed over: any lock that stopped it would put back exactly
       * the waiting this feature removes. What the demo owes a person in
       * that moment is the reason, before they conclude the keyboard is
       * broken.
       */}
      {drivers.length > 1 && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: '#e6c37e', background: '#1b1810' }}>
          {agentIsDriving
            ? 'You and an agent are driving this tab. It types into the focused field without noticing you are in it, so your characters and its characters interleave. Take over if you want the field to yourself.'
            : `${drivers.length} people are driving this tab. Typing goes to the same page, so characters interleave. Watch the cursors to see who is where.`}
        </div>
      )}
      {agent !== null && (
        <AgentPaneStrip
          status={agent}
          takeover={agentTakeover}
          holdingNow={agentIsDriving}
          busy={agentBusy}
          onTakeOver={onAgentTakeOver}
          onHandBack={onAgentHandBack}
        />
      )}
      <DiagnosticsPanel client={client} targetId={target.targetId} />
    </div>
  );
}

/**
 * The full size, single target driving view. Mounted only while
 * `expandedTargetId` is set, and only ever for one target at a time (see
 * `Pane`'s `expanded` doc comment for why exactly one, never two,
 * `<BrowserGlass/>` per target matters). Closing it (the button, the
 * backdrop, or Escape) unmounts this component, which is what actually
 * releases a held lease and unsubscribes the stream, via
 * `<BrowserGlass/>`'s own unmount cleanup; there is nothing extra to
 * release here.
 */
function ExpandedModal({
  client,
  target,
  onClose,
  myViewerId,
  viewers,
  posture,
  agentViewerId,
  onControlError,
}: {
  client: BrowserGlassClient;
  target: TargetSummary;
  onClose: () => void;
  myViewerId: string | null;
  viewers: readonly ViewerPresence[];
  posture: Posture;
  /** The demo agent's viewer id, so a robot holder is named as one here too. `null` when no agent is running. */
  agentViewerId: string | null;
  /** Same contract as `Pane`'s prop of the same name: a rejected request/release, surfaced rather than swallowed. */
  onControlError: (message: string) => void;
}) {
  const nav = useNav(client, target.targetId);
  const leaseHook = useControlLease(client, target.targetId);
  const leaseState = useLeaseState(client, target.targetId);
  const drivers = withAgentLabels(
    driversOf(leaseState, viewers, target.targetId, myViewerId),
    agentViewerId,
  );
  const iAmDriving = drivers.some((d) => d.isMe);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the modal through the window keydown listener above.
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 'min(1200px, 100%)',
          height: 'min(800px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          background: '#111318',
          border: '2px solid #7db1ff',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            background: '#181a20',
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 4,
              background: target.active ? '#1e5c2c' : '#5c4a1e',
              color: target.active ? '#7ee69a' : '#e6c37e',
              whiteSpace: 'nowrap',
            }}
          >
            {target.active ? 'LIVE' : 'POLLING'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AddressBar
              url={nav.url}
              loading={nav.loading}
              canGoBack={nav.canGoBack}
              canGoForward={nav.canGoForward}
              canNavigate={nav.canNavigate}
              securityState={nav.securityState}
              onNavigate={nav.goto}
              onBack={nav.back}
              onForward={nav.forward}
              onReload={() => nav.reload()}
              onStop={nav.stop}
              blocked={nav.blocked}
              onDismissBlocked={nav.dismissBlocked}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            Close
          </button>
        </div>
        <DriverRail drivers={drivers} />
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <BrowserGlass
            client={client}
            targetId={target.targetId}
            fit="contain"
            // Opening a tab full size is an explicit act of picking it up,
            // so a driver gets control on mount here rather than waiting
            // for a first click. A watcher does not: the posture is the
            // viewer's own statement about what they came to do, and the
            // full size view is not a loophole in it.
            autoControl={posture === 'drive' ? 'onMount' : 'never'}
            interactive
            overlay={({ toClient }) => (
              <PaneCursors
                client={client}
                targetId={target.targetId}
                myViewerId={myViewerId}
                drivingViewerIds={drivers.map((d) => d.viewerId)}
                toClient={toClient}
              />
            )}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 10px',
            background: '#181a20',
          }}
        >
          <ControlBadge lease={leaseState} myViewerId={myViewerId} drivers={drivers} showMode />
          <RequestControlButton
            lease={leaseState}
            myViewerId={myViewerId}
            canRequest={leaseHook.canRequest}
            requesting={leaseHook.requesting}
            iAmDriving={iAmDriving}
            onRequest={() =>
              void leaseHook
                .request()
                .catch((err) => onControlError(err instanceof Error ? err.message : String(err)))
            }
            onRelease={() =>
              void leaseHook
                .release()
                .catch((err) => onControlError(err instanceof Error ? err.message : String(err)))
            }
          />
        </div>
      </div>
    </div>
  );
}

export default function BrowserWallPage() {
  const [query, setQuery] = useState<PageQuery | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [acquireError, setAcquireError] = useState<string | null>(null);
  /** One line of plain language about the last thing a button did. Not an error. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Set by "Close browsers", cleared by "Start browsers" and by any
   * successful acquire. It stops the mount effect below from acquiring
   * again the instant the release lands, which would otherwise make the
   * close button look like a very slow reload button.
   */
  const [stopped, setStopped] = useState(false);
  const openedExtraTabs = useRef(false);
  /** Guards against the mount effect and a button both acquiring at once. */
  const acquiring = useRef(false);
  const [focusedTargetId, setFocusedTargetId] = useState<string | null>(null);
  const [expandedTargetId, setExpandedTargetId] = useState<string | null>(null);
  /**
   * Defaults to `'drive'`, which is the user's own stated expectation for
   * this feature: "able to control immediately if needed, which is most
   * likely how most people will use". Landing in `'watch'` and making
   * everyone find a switch before their first click would be defaulting to
   * the rarer case. Nothing is seized by defaulting this way, because the
   * panes are `autoControl: 'onInteract'`: a viewer who opens the page and
   * reads it drives nothing at all until they touch a pane.
   */
  const [posture, setPosture] = useState<Posture>('drive');

  // Reads the query string after mount only (window is unavailable during
  // SSR). null means "not read yet", which is distinct from "read, both
  // parameters absent" and is why nothing acquires until this has run.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQuery({ instanceId: params.get('instanceId'), workspace: params.get('workspace') });
  }, []);

  /**
   * The one place this page talks to `POST /api/browser`.
   *
   * The default call sends the workspace id, if any, and nothing else, so
   * the server acquires with `sticky` and the visitor gets back whichever
   * browsers already belong to them (or to the workspace). That is the
   * whole fix for "a new set of three Chrome windows every time I open
   * this page": the reuse decision is now expressed in the request rather
   * than left to a ten second idempotency bucket.
   *
   * `fresh: true` is the deliberate opt out. It also drops `?instanceId=`,
   * because "give me a new set" cannot coherently also mean "attach me to
   * the exact instance named in my URL".
   */
  const acquire = useCallback(
    async (opts: { fresh?: boolean } = {}): Promise<void> => {
      if (query === null) return;
      acquiring.current = true;
      setAcquireError(null);
      try {
        const r = await fetch('/api/browser', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(query.instanceId !== null && opts.fresh !== true
              ? { instanceId: query.instanceId }
              : {}),
            ...(query.workspace !== null ? { workspace: query.workspace } : {}),
            ...(opts.fresh === true ? { fresh: true } : {}),
          }),
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
        const data = body as Credentials;
        // A new socket, possibly to a different instance, so let the tab
        // opener below re-evaluate. On the ordinary sticky reuse path the
        // instance already has its three targets and the opener marks
        // itself done without opening anything.
        openedExtraTabs.current = false;
        setFocusedTargetId(null);
        setExpandedTargetId(null);
        setStopped(false);
        setCreds(data);
      } catch (err) {
        setAcquireError(err instanceof Error ? err.message : String(err));
      } finally {
        acquiring.current = false;
      }
    },
    [query],
  );

  useEffect(() => {
    if (query === null || creds !== null || stopped || acquiring.current) return;
    void acquire();
  }, [query, creds, stopped, acquire]);

  /**
   * Throws away the browsers this page is currently on and launches a
   * genuinely new set.
   *
   * Reuse is the default now, so this is what makes the default safe: a
   * visitor whose Chrome has got itself into a bad state would otherwise
   * have no way to ask for a clean one short of waiting out the idle
   * reaper.
   *
   * The release goes first, so the machine never ends up carrying two sets
   * for one subject. It is allowed to come back `detached` instead of
   * `terminated`: the browsers stay up for whoever else is still watching
   * them and this visitor simply gets a separate new set. That outcome is
   * reported rather than swallowed.
   *
   * It does NOT pass `force`. The router grew `ReleaseOptions.force` for
   * exactly this kind of "the user deliberately asked to discard these"
   * call, and it was tempting. The reason not to: in a shared workspace
   * the browsers this button discards are not only this visitor's, and no
   * viewer should be able to end a session other people are still in from
   * an ordinary page button. Getting a separate new set, and being told
   * why, is the worse outcome for one person and the right one for the
   * room. `force` belongs to the router's own sweeps and to an operator.
   */
  const newBrowserSet = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      if (creds !== null) {
        const r = await fetch('/api/browser/release', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instanceId: creds.instanceId }),
        });
        const body = (await r.json().catch(() => ({}))) as ReleaseOutcome;
        if (body.outcome === 'detached') {
          setNotice(
            'Left the old browsers running: someone else is still watching them. You now have a separate new set.',
          );
        }
      }
      await acquire({ fresh: true });
    } finally {
      setBusy(false);
    }
  }, [creds, acquire]);

  /**
   * Stops this visitor's browsers on purpose.
   *
   * This is the replacement for the automatic release that used to fire on
   * `pagehide` (see the lifecycle comment further down): closing a tab is
   * now a reversible thing, and closing the browsers is a button.
   */
  const closeBrowsers = useCallback(async (): Promise<void> => {
    if (creds === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch('/api/browser/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: creds.instanceId }),
      });
      const body = (await r.json().catch(() => ({}))) as ReleaseOutcome;
      if (body.outcome === 'detached') {
        setNotice(
          `Not closed: ${body.remainingViewers ?? 2} viewers are connected to these browsers. They stay up for the others.`,
        );
        return;
      }
      setCreds(null);
      setStopped(true);
      setNotice('Browsers closed. Nothing is running for you now.');
    } finally {
      setBusy(false);
    }
  }, [creds]);

  const refresh = useCallback(async (): Promise<string> => {
    if (!creds) throw new Error('no credentials to refresh');
    const r = await fetch('/api/browser/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: creds.instanceId, sessionId: creds.sessionId }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
    return body.token as string;
  }, [creds]);

  const wsUrl = useMemo(() => {
    if (!creds || typeof window === 'undefined') return '';
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}${creds.wsPath}`;
  }, [creds]);

  const credentialsOption = useMemo(
    () => (creds ? async () => ({ token: await refresh() }) : undefined),
    [creds, refresh],
  );

  const bgOptions = useMemo(
    () => ({
      url: wsUrl,
      token: creds?.token,
      credentials: credentialsOption,
      // Off by default in the SDK, on here, because with several people
      // driving one page the cursors are not decoration: they are the only
      // thing that attributes an interleaved keystroke to a person rather
      // than to a glitch. The client throttles the publish to one message
      // per 40ms and rides it on `input.mouse` moves it was already
      // sending, so it costs no extra round trip.
      presenceCursor: true,
      debug: true,
    }),
    [wsUrl, creds?.token, credentialsOption],
  );

  const bg = useBrowserGlass(bgOptions);

  const targetsApi = useTargets(bg.client);
  const presence = usePresence(bg.client);
  const stats = useInstanceStats(bg.client, { intervalMs: 1000 });

  const agent = useAgent(creds?.instanceId ?? null);
  /** What this page measured about the last takeover. Cleared when the agent is handed back. */
  const [takeover, setTakeover] = useState<TakeoverMeasurement | null>(null);

  /**
   * The tab the agent is asked to drive: the middle one of three.
   *
   * Middle rather than first for one reason, and it is a real one. The wall
   * reads left to right, and a visitor's eye lands on the leftmost pane
   * first; putting the agent there would make "a browser driving itself"
   * look like the whole demo rather than one of three tabs, two of which
   * are still ordinary tabs a person drives. In the middle it reads as what
   * it is: some of these are being worked by people, one is being worked by
   * software, and they are the same kind of thing.
   */
  const agentTargetId = useMemo(
    () => targetsApi.targets[1]?.targetId ?? targetsApi.targets[0]?.targetId ?? null,
    [targetsApi.targets],
  );

  /** 1-based position of the agent's pane in the grid, for the console's "tab 2". */
  const agentTabNumber = useMemo(() => {
    const id = agent.status?.targetId ?? null;
    if (id === null) return null;
    const i = targetsApi.targets.findIndex((t) => t.targetId === id);
    return i === -1 ? null : i + 1;
  }, [agent.status?.targetId, targetsApi.targets]);

  /**
   * Taking the tab off the agent: two separate acts, one button, and both
   * of them on the wire.
   *
   * FIRST the person takes control. In `mode: 'shared'` that is granted on
   * the spot with nothing queued and nobody evicted, so by the time this
   * line resolves the person is genuinely one of the holders. Their claim
   * does not depend on the agent agreeing to anything, which is why it goes
   * first and why it is not conditional on the second call succeeding.
   *
   * THEN the agents on that tab are asked to stand down, with
   * `client.yieldControl()`, which sends the protocol's own `control.yield`.
   * Preemption is not available here: it is an exclusive-mode concept and
   * the engine emits none of it for a shared target, because nobody queues
   * there. `control.yield` is the shared-mode instrument, it asks only the
   * AGENT holders, and it leaves every person driving the same tab alone.
   *
   * This used to be an HTTP call to the demo's own server, because no
   * client could send the message. That is gone.
   */
  const takeOverFromAgent = useCallback(async (): Promise<void> => {
    const targetId = agent.status?.targetId ?? agentTargetId;
    const agentViewerId = agent.status?.viewerId ?? null;
    const client = bg.client;
    if (targetId === null || client === null) return;

    setTakeover(null);
    const startedAt = performance.now();
    await client.requestControl(targetId).catch(() => undefined);

    let agentsAsked = 0;
    try {
      // Both of this call's refusals are decided locally and thrown, so a
      // caught error here means the yield never left the machine and the
      // agent was never asked. That is worth showing rather than swallowing.
      const result = await client.yieldControl(targetId, 'a person taking over');
      agentsAsked = result.agentsAsked;
    } catch (err) {
      setTakeover({
        ms: null,
        agentsAsked: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const ms =
      agentViewerId === null ? null : await waitForHolderGone(client, targetId, agentViewerId);
    setTakeover({ ms, agentsAsked, error: null });
  }, [agent.status?.targetId, agent.status?.viewerId, agentTargetId, bg.client]);

  /**
   * Giving it back, which is also two acts: the person lets go of the
   * lease, and the agent is told it may pick it up again. Releasing first
   * matters less here than it did above (in shared mode the agent can take
   * a lease while the person still holds one), but a person who says "you
   * have it back" and then keeps holding the tab is saying two different
   * things at once, and the driver rail would show it.
   */
  const handBackToAgent = useCallback(async (): Promise<void> => {
    const targetId = agent.status?.targetId ?? agentTargetId;
    const client = bg.client;
    if (targetId !== null && client) {
      await client.releaseControl(targetId).catch(() => undefined);
    }
    setTakeover(null);
    await agent.act('handBack');
  }, [agent, agentTargetId, bg.client]);

  const startAgent = useCallback((): void => {
    if (agentTargetId === null) return;
    // The session id goes with it. The route prefers the live registry and
    // uses this only when the registry has nothing, which is the case for
    // an instance nobody has connected to yet.
    void agent.act('start', { targetId: agentTargetId, sessionId: creds?.sessionId });
  }, [agent, agentTargetId, creds?.sessionId]);

  /**
   * Switching to "Watch" gives back every lease this viewer is holding,
   * rather than only changing what future clicks do.
   *
   * Saying "I am only watching" while still holding three tabs would make
   * the switch a lie in the one direction where the lie matters: the other
   * people in the room read the driver rails and the badges, and they
   * would still be told this viewer is driving. The list of leases to give
   * back comes from presence (`me.controlling`), which is the server's own
   * account of what this viewer holds, so nothing local has to be trusted
   * to be in step with it.
   *
   * Switching the other way takes nothing. `autoControl: 'onInteract'`
   * means the first click on a pane is what makes this viewer a driver of
   * it, which in shared mode is granted on the spot.
   */
  const changePosture = useCallback(
    (next: Posture): void => {
      setPosture(next);
      if (next !== 'watch') return;
      const client = bg.client;
      const held = presence.me?.controlling ?? [];
      if (!client || held.length === 0) return;
      for (const targetId of held) {
        void client.releaseControl(targetId).catch(() => undefined);
      }
    },
    [bg.client, presence.me],
  );

  // Once connected to a freshly launched instance (never a second viewer
  // attaching to one that already has panes), open two more tabs through
  // the real tabs API: `useTargets().open()`.
  // `BrowserRouter`/`ManagedSession.newTarget` has no path reachable from
  // outside `@browserglass/server`'s own internals, so this client side
  // call is the one genuinely public "real tabs API" this example can use.
  useEffect(() => {
    if (openedExtraTabs.current) return;
    if (!bg.connected || targetsApi.targets.length === 0) return;
    if (targetsApi.targets.length >= 3) {
      openedExtraTabs.current = true;
      return;
    }
    openedExtraTabs.current = true;
    const need = 3 - targetsApi.targets.length;
    (async () => {
      for (let i = 0; i < need; i++) {
        await targetsApi.open('https://example.com', { background: true }).catch(() => undefined);
      }
    })();
  }, [bg.connected, targetsApi]);

  useEffect(() => {
    if (focusedTargetId === null && targetsApi.targets.length > 0) {
      setFocusedTargetId(targetsApi.targets[0]!.targetId);
    }
  }, [focusedTargetId, targetsApi.targets]);

  /**
   * THE LIFECYCLE, and why there is no `pagehide` release here any more.
   *
   * This page used to register a `pagehide` handler that fired
   * `navigator.sendBeacon('/api/browser/release', ...)`, so that closing
   * the tab destroyed the browsers it had launched. That was the right
   * answer when every page load launched its own throwaway set: without it
   * a handful of refreshes left a row of abandoned Chrome windows on the
   * desktop.
   *
   * It is the wrong answer now, and not by a small margin. Reloading a
   * page fires `pagehide` exactly the same way closing it does, and the
   * two are not distinguishable from script. So the beacon would destroy
   * the instance on every refresh, the new page would find nothing to
   * stick to, and it would launch a replacement: the exact "new set of
   * browsers every time" behaviour sticky reuse exists to stop. Keeping
   * both features would have meant keeping neither.
   *
   * What replaces it:
   *
   * 1. Reload, or a second tab, or a revisit: `POST /api/browser` asks for
   *    `sticky: { subject }` and gets the same instance back, `reused:
   *    true, reuseReason: 'sticky'`. Nothing new is launched, which is the
   *    "excess browsers should not be spawned except what is used" half of
   *    the requirement, enforced at the moment of acquiring rather than by
   *    frantically cleaning up afterwards.
   * 2. Tab closed and never reopened: the instance sits idle. The router
   *    reaper releases it after the pool idle timeout (15 minutes) plus a
   *    grace (10 minutes), which is the same backstop that has always been
   *    there. Nothing leaks forever.
   * 3. The user wants them gone now: the "Close browsers" button
   *    (`closeBrowsers` above), which is a release the user actually
   *    asked for and can see the result of.
   * 4. The app itself closes: server.mjs's SIGINT/SIGTERM handler calls
   *    `bg.stop()`, which releases every instance and terminates its
   *    browser, and `createHostRuntime({ killOnShutdown: true })` kills
   *    anything that survives a non-graceful exit. "When the app is
   *    closed, its spawned browsers close" is a property of the process
   *    lifetime, and it always was: a tab is not the app.
   *
   * None of the paths above can pull a browser out from under a colleague
   * who is still watching it through a `?workspace=` link:
   * `BrowserRouter.release` terminates only when no viewers remain and
   * reports `outcome: 'detached'` otherwise, and this demo never passes
   * `force`.
   */

  /** The "join exactly this instance" link. Narrow and immediate: it names one running browser and never launches. */
  const instanceShareUrl = useMemo(() => {
    if (!creds || typeof window === 'undefined') return '';
    const u = new URL(window.location.href);
    u.searchParams.set('instanceId', creds.instanceId);
    return u.toString();
  }, [creds]);

  /**
   * The "collaborate on these browsers" link. Durable in a way the
   * instance link is not: it survives the instance being replaced, because
   * it names the workspace rather than one particular Chrome. Only exists
   * while this page is in a workspace.
   */
  const workspaceShareUrl = useMemo(() => {
    const ws = query?.workspace ?? null;
    if (ws === null || typeof window === 'undefined') return '';
    const u = new URL(window.location.href);
    u.searchParams.delete('instanceId');
    u.searchParams.set('workspace', ws);
    return u.toString();
  }, [query?.workspace]);

  /**
   * Moves this tab into a brand new shared workspace.
   *
   * A full navigation rather than in-place state, because the workspace id
   * IS the thing being shared: whoever the link is sent to has to land on
   * the same URL this tab now shows, and a URL that exists only in React
   * state cannot be copied out of the address bar.
   *
   * It acquires a SEPARATE set of browsers rather than moving the current
   * ones across. An instance's `subject` is stamped once, at acquire time
   * (`BrowserRouter.doAcquire`: `subject: req.subject ?? principal.sub`),
   * and no router call re-stamps it, so "promote my solo browsers into a
   * workspace" cannot be expressed against today's SDK. The solo set is
   * left alone and comes back by dropping the query parameter. Re-stamping
   * an instance's subject is a missing SDK feature.
   */
  const startWorkspace = useCallback((): void => {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
    const u = new URL(window.location.href);
    u.searchParams.delete('instanceId');
    u.searchParams.set('workspace', id);
    window.location.assign(u.toString());
  }, []);

  /** Drops both selectors and reloads, which lands the visitor back on their own personal browsers. */
  const leaveWorkspace = useCallback((): void => {
    const u = new URL(window.location.href);
    u.searchParams.delete('workspace');
    u.searchParams.delete('instanceId');
    window.location.assign(u.toString());
  }, []);

  /** Which browsers this page is looking at, in words. */
  const modeLabel = useMemo(() => {
    if (creds === null) return null;
    if (creds.mode === 'attached') return 'Joined one specific browser set by link';
    if (creds.mode === 'workspace') return `Shared workspace: ${creds.workspace ?? ''}`;
    return 'Solo: your own browsers';
  }, [creds]);

  /** Whether the last acquire reused something or launched, in words. */
  const originLabel = useMemo(() => {
    if (creds === null) return null;
    if (!creds.reused) return 'Launched a new set';
    if (creds.reuseReason === 'sticky') return 'Reused the browsers you already had';
    if (creds.reuseReason === 'idempotent')
      return 'Reused the result of the request just before this one';
    return `Reused existing browsers (${creds.reuseReason ?? 'attached'})`;
  }, [creds]);

  return (
    <main
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: '100vh' }}
    >
      {/*
       * Two rows on purpose. The first is who you are and what you can do,
       * which is what somebody looking at two windows side by side needs;
       * the second is the browser lifecycle buttons, which are used once a
       * session. Flattening them into one row, which is what this was,
       * buried the participation switch among six other buttons.
       */}
      <header style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>BrowserGlass wall</h1>
          <PostureSwitch posture={posture} onChange={changePosture} disabled={!bg.client} />
          <span style={{ fontSize: 12, color: '#9aa', maxWidth: 420, lineHeight: 1.4 }}>
            {posture === 'drive'
              ? 'Click any tab to start driving it. Others driving the same tab keep driving: nobody is queued and nobody is kicked out.'
              : 'You are watching. Your cursor is still visible to everyone. Take control of any single tab whenever you want it.'}
          </span>
          <div style={{ flex: 1 }} />
          <IdentityChip me={presence.me} />
          <ViewerList
            viewers={presence.viewers}
            myViewerId={presence.me?.viewerId ?? null}
            compact
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {creds && (
            <span
              style={{
                fontSize: 12,
                color: '#9aa',
                display: 'flex',
                flexDirection: 'column',
                lineHeight: 1.4,
              }}
            >
              <strong style={{ color: '#7db1ff', fontSize: 12 }}>{modeLabel}</strong>
              <span>
                {originLabel}. Instance <code>{creds.instanceId}</code>
              </span>
            </span>
          )}
          {creds && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(instanceShareUrl);
              }}
              title="Join this exact browser set. Immediate, but only valid while this instance lives."
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              Copy link for a second viewer
            </button>
          )}
          {query?.workspace != null && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(workspaceShareUrl);
              }}
              title="Anyone who opens this link collaborates on this workspace, now or later."
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              Copy workspace link
            </button>
          )}
          {query !== null && query.workspace === null && (
            <button
              type="button"
              onClick={startWorkspace}
              title="Opens a separate, shareable set of browsers. Your own set is left running and comes back when you drop the workspace parameter."
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              Start a shared workspace
            </button>
          )}
          {query?.workspace != null && (
            <button
              type="button"
              onClick={leaveWorkspace}
              title="Back to the browsers only you can see"
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              Back to my own browsers
            </button>
          )}
          <button
            type="button"
            onClick={() => void newBrowserSet()}
            disabled={busy || query === null}
            title="Release the current browsers and launch a genuinely new set. Reuse is the default, this is the way out of it."
            style={{ fontSize: 12, padding: '4px 8px' }}
          >
            New browser set
          </button>
          {creds && (
            <button
              type="button"
              onClick={() => void closeBrowsers()}
              disabled={busy}
              title="Stop these browsers now. Refused while another viewer is still connected."
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              Close browsers
            </button>
          )}
          {stopped && (
            <button
              type="button"
              onClick={() => setStopped(false)}
              disabled={busy}
              style={{ fontSize: 12, padding: '4px 8px' }}
            >
              Start browsers
            </button>
          )}
        </div>
      </header>

      {/* Two keyframes and their reduced-motion escape. See AGENT_CSS. */}
      <style>{AGENT_CSS}</style>

      {bg.client && (
        <AgentConsole
          status={agent.status}
          takeover={takeover}
          busy={agent.busy}
          onStart={startAgent}
          onStop={() => void agent.act('stop')}
          onTakeOver={() => void takeOverFromAgent()}
          onHandBack={() => void handBackToAgent()}
          tabNumber={agentTabNumber}
          disabled={agentTargetId === null}
        />
      )}

      <ConnectionBanner
        state={bg.state}
        attempt={bg.reconnectAttempt}
        nextDelayMs={null}
        error={bg.fatal}
        onRetry={bg.reconnect}
      />

      {acquireError && <p style={{ color: '#e67e7e' }}>Failed to open a browser: {acquireError}</p>}
      {notice && <p style={{ color: '#e6c37e', fontSize: 13, margin: 0 }}>{notice}</p>}
      {!creds && !acquireError && !stopped && <p>Starting a browser…</p>}

      {bg.client && (
        <TabStrip
          targets={targetsApi.targets}
          activeTargetId={focusedTargetId}
          onSelect={(id) => {
            setFocusedTargetId(id);
            void targetsApi.activate(id);
          }}
          // A bare targetsApi.open() defaults to about:blank server side.
          // That is a real, correctly streamed frame, not a bug, but a
          // blank page in a dark Chrome profile renders close to solid
          // black (RGB 18,18,18, Chrome's own dark surface colour), which
          // reads as broken next to this demo's own dark chrome. Opening a
          // real page instead makes every new pane visibly alive.
          onNew={() => void targetsApi.open('https://example.com')}
          onClose={(id) => {
            void targetsApi.close(id);
            setExpandedTargetId((cur) => (cur === id ? null : cur));
          }}
          canManage={targetsApi.canManage}
        />
      )}

      {bg.client && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: 12,
          }}
        >
          {targetsApi.targets.map((t) => (
            <Pane
              key={t.targetId}
              client={bg.client!}
              target={t}
              focused={t.targetId === focusedTargetId}
              onFocus={() => setFocusedTargetId(t.targetId)}
              myViewerId={presence.me?.viewerId ?? null}
              viewers={presence.viewers}
              posture={posture}
              onExpand={() => setExpandedTargetId(t.targetId)}
              expanded={t.targetId === expandedTargetId}
              // Passed to exactly one pane: the tab the agent reports it is
              // on. Every other pane gets null and draws no robot marking at
              // all, which is what keeps "which one is the agent" a glance
              // rather than a hunt.
              agent={agent.status?.targetId === t.targetId ? agent.status : null}
              agentTakeover={agent.status?.targetId === t.targetId ? takeover : null}
              agentBusy={agent.busy}
              onAgentTakeOver={() => void takeOverFromAgent()}
              onAgentHandBack={() => void handBackToAgent()}
              onControlError={(message) => setNotice(message)}
            />
          ))}
        </div>
      )}

      {bg.client &&
        expandedTargetId &&
        (() => {
          const expandedTarget = targetsApi.targets.find((t) => t.targetId === expandedTargetId);
          // The target this modal was opened for can disappear mid-session
          // (closed from the TabStrip by this viewer or, since tabs.manage
          // is shared, by another one); render nothing rather than a modal
          // for a target that no longer exists.
          if (!expandedTarget) return null;
          return (
            <ExpandedModal
              client={bg.client!}
              target={expandedTarget}
              onClose={() => setExpandedTargetId(null)}
              myViewerId={presence.me?.viewerId ?? null}
              viewers={presence.viewers}
              posture={posture}
              agentViewerId={agent.status?.viewerId ?? null}
              onControlError={(message) => setNotice(message)}
            />
          );
        })()}

      <DebugOverlay
        fps={stats.fps}
        rttMs={stats.rttMs}
        backlog={stats.backlog}
        droppedFrames={stats.droppedFrames}
        bytesPerSec={stats.bytesPerSec}
        decodeMsP50={stats.decodeMsP50}
        decodeMsP95={stats.decodeMsP95}
        codec={stats.codec}
        quality={stats.quality}
        position="bottom-right"
        expanded
      />
    </main>
  );
}
