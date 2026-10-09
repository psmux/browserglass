/**
 * A single purpose CDP call: `Browser.close`, used only by the terminate
 * ladder's `'clean'` tier (Chrome writes Cookies, Local Storage and
 * Preferences on a controlled shutdown; SIGKILL leaves SQLite WAL files and
 * the SingletonLock behind). Deliberately not a general CDP client:
 * `@browserglass/core`'s `CdpBridge` is that, and this package keeps small
 * local copies for the same reason `identity-probe.ts` carries a local copy
 * of `probeCdpIdentity` (see that file's header).
 * One command, one response, one socket, then done.
 */

/**
 * Connects to `cdpWsUrl`, sends `Browser.close`, and resolves once Chrome
 * acknowledges it or the socket closes on its own (both count as
 * "requested"), or rejects on `timeoutMs`. Never throws for a browser that
 * was already gone, since `Browser.close` on a dead browser has nothing
 * useful to acknowledge.
 */
export function sendBrowserClose(cdpWsUrl: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closed or never opened; nothing to clean up.
      }
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    let ws: WebSocket;
    try {
      ws = new WebSocket(cdpWsUrl);
    } catch {
      clearTimeout(timer);
      resolve();
      return;
    }

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch {
        finish();
      }
    });
    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { id?: number };
        if (data.id === 1) finish();
      } catch {
        // Non JSON or unrelated frame; keep waiting until the timeout.
      }
    });
    ws.addEventListener('close', finish);
    ws.addEventListener('error', finish);
  });
}
