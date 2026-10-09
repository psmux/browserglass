import { type NextRequest, NextResponse } from 'next/server';
import { agentStatus, handBackAgent, startAgent, stopAgent } from '../../../../lib/agent';
import { getBg } from '../../../../lib/bgls';

/**
 * The demo's control surface over its own agent (`lib/agent.ts`).
 *
 * Deliberately an ordinary HTTP route, and deliberately not part of the
 * BrowserGlass protocol. The agent is this application's program: it was
 * started by this app, it holds a token this app minted, and telling it to
 * stop is this app's business, exactly as it would be in a real deployment
 * where the agent is a worker somewhere and the product's own backend is
 * what tells it to stop.
 *
 * THERE IS NO STAND-DOWN ACTION HERE, and there used to be. Taking the tab
 * off the agent is a protocol act now: the page sends `control.yield` with
 * `client.yieldControl()`, the gateway routes it, and the engine asks the
 * agent holders of that shared target to stand down. Keeping an HTTP
 * shortcut beside it would mean two ways to do one thing, one of which
 * only works for an agent this particular app happens to have started.
 *
 * What is left here is lifecycle, which is genuinely the application's
 * business and has no protocol equivalent: start this worker, tell it it
 * may go again, stop it. Nothing in `bgls.v1` grants an agent permission to
 * drive; an agent asks for control like anybody else, and whether it should
 * be asking at all is a question for the application, not for the browser.
 *
 * GET `?instanceId=` reports what the agent is doing. POST takes
 * `{ instanceId, action }`, plus `sessionId` and `targetId` on `start`.
 */

/** Where the agent should dial back in, which is this same process. */
function wsOrigin(req: NextRequest): string {
  const host = req.headers.get('host') ?? `localhost:${process.env.PORT ?? 3000}`;
  const proto = req.nextUrl.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const instanceId = req.nextUrl.searchParams.get('instanceId');
  if (instanceId === null) {
    return NextResponse.json(
      { error: { code: 'E_MISSING_PARAM', message: 'instanceId query parameter is required.' } },
      { status: 400 },
    );
  }
  return NextResponse.json({ agent: agentStatus(instanceId) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    instanceId?: unknown;
    sessionId?: unknown;
    targetId?: unknown;
    action?: unknown;
  };
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId : null;
  const action = typeof body.action === 'string' ? body.action : null;

  if (instanceId === null || action === null) {
    return NextResponse.json(
      { error: { code: 'E_MISSING_PARAM', message: 'instanceId and action are both required.' } },
      { status: 400 },
    );
  }

  try {
    switch (action) {
      case 'start': {
        // Optional. Omitted, the agent binds to the instance's active
        // target and reports back which one that was. The wall page names
        // a tab because it is showing three; a caller with one tab should
        // not have to look its id up first.
        const targetId = typeof body.targetId === 'string' ? body.targetId : null;
        const bg = getBg();
        /*
         * The agent's token is scoped to a session id, so one has to be
         * resolved before it can be minted. Two sources, live registry
         * first:
         *
         * `bg.sessions` is the in-process `SessionRegistry`, which holds a
         * `ManagedSession` per instance somebody is actually connected to.
         * When the wall page is open, that is the authoritative answer and
         * it cannot be stale.
         *
         * It is EMPTY, though, for an instance nobody has connected to yet.
         * A `ManagedSession` is built when the first socket attaches, not
         * when the router launches the browser, so an agent started against
         * a freshly acquired instance would be refused for a session that is
         * about to exist. So the caller's own `sessionId`, straight from the
         * acquire that created it, is the fallback rather than the primary:
         * right when the registry has nothing to say, and overridden by the
         * registry when it does.
         */
        const live = (await bg.sessions.list({ instanceId })).items[0]?.sessionId ?? null;
        const claimed =
          typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null;
        const sessionId = live ?? claimed;
        if (sessionId === null) {
          return NextResponse.json(
            {
              error: {
                code: 'E_NO_SESSION',
                message:
                  'No session for that instance, and none supplied. Pass the sessionId from your acquire.',
              },
            },
            { status: 409 },
          );
        }
        const agent = await startAgent({
          instanceId,
          sessionId,
          targetId,
          origin: wsOrigin(req),
        });
        return NextResponse.json({ agent });
      }
      case 'handBack':
        return NextResponse.json({ agent: handBackAgent(instanceId) });
      case 'stop':
        return NextResponse.json({ agent: await stopAgent(instanceId) });
      default:
        return NextResponse.json(
          {
            error: {
              code: 'E_BAD_ACTION',
              message: `Unknown action '${action}'. Expected start, handBack or stop. Standing the agent down is control.yield on the wire, not an action here.`,
            },
          },
          { status: 400 },
        );
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return NextResponse.json(
      { error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Unknown error.' } },
      { status: 500 },
    );
  }
}
