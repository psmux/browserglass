/**
 * What the two ends of the demo's agent have to agree on: where the field
 * it types into is, and the shape of the status it reports.
 *
 * Kept apart from `lib/agent.ts` because that module imports
 * `@browserglass/server` and `@browserglass/automation`, both of which are
 * Node-only. The wall page needs the status TYPE and the lab page needs the
 * coordinate, and neither should drag a server module into the browser
 * bundle to get them.
 *
 * ── the coordinate ──
 *
 * `AutomationClient.clickAt` takes viewport CSS pixels. The locator engine
 * (`click('#q')`) is not built in this pass and throws `NOT_IMPLEMENTED` if
 * called, so an agent that wants to put text in a field has to know where
 * the field is. Rather than hard-coding a pair of numbers in the runner and
 * hoping nobody restyles the page, the page positions the field FROM this
 * constant and the runner clicks the centre of it. Move it here and both
 * ends follow.
 *
 * This lives in `lib/` rather than in the page module because a Next App
 * Router `page.tsx` may only export a default component and the framework's
 * own reserved names; a stray named export is a build error, not a lint
 * warning.
 */
export const LAB_FIELD = { left: 64, top: 268, width: 760, height: 96 } as const;

/** The centre of {@link LAB_FIELD}, which is where a click has to land to focus it. */
export const LAB_FIELD_CENTRE = {
  x: LAB_FIELD.left + Math.round(LAB_FIELD.width / 2),
  y: LAB_FIELD.top + Math.round(LAB_FIELD.height / 2),
} as const;

/** Where the agent lab lives, relative to this app's own origin. */
export const LAB_PATH = '/agent-lab';

/** What the agent is doing, in one word. */
export type AgentPhase = 'off' | 'starting' | 'working' | 'stood-down' | 'error';

/**
 * Everything the wall page needs to draw the agent, as it comes back from
 * `GET /api/browser/agent`. Plain data on purpose: the page polls this and
 * renders it, and holds no opinion of its own about what the agent is
 * doing.
 */
export interface AgentStatus {
  phase: AgentPhase;
  /** One plain sentence about what it is doing right now. Changes several times a cycle. */
  step: string;
  /** The tab it drives, so the page can put the robot marking on the right pane. */
  targetId: string | null;
  /** Its viewer id, so the page can recognise it in the presence roster and on the driver rail. */
  viewerId: string | null;
  instanceId: string | null;
  /** Completed loops since it started. */
  cycles: number;
  /**
   * Who took the tab, as the agent understood it from the wire. Null while
   * it is running.
   *
   * There is deliberately no timing here. How long a takeover took is
   * measured by the WALL PAGE, off `control.state`, because that is the
   * moment a person can actually observe; an agent timing its own
   * stand-down would be timing its opinion of itself.
   */
  stoodDownFor: string | null;
  error: string | null;
}
