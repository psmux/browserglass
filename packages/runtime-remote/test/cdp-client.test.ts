import { describe, expect, it } from 'vitest';
import { RemoteCdpClient, RemoteCdpError } from '../src/cdp-client.js';
import {
  FakeRemoteWebSocket,
  fakeFetch,
  fakeWebSocketFactory,
  installDefaultResponder,
} from './fake-remote-endpoint.js';

describe('RemoteCdpClient.fetchVersion', () => {
  it('parses webSocketDebuggerUrl, browserGuid, product, protocol version, and user agent', async () => {
    const guidByOrigin = new Map([
      [
        'http://127.0.0.1:9222',
        { origin: 'http://127.0.0.1:9222', browserGuid: 'guid-1', product: 'Chrome/131.0.6778.86' },
      ],
    ]);
    const client = new RemoteCdpClient({ fetchImpl: fakeFetch(guidByOrigin) });
    const version = await client.fetchVersion('http://127.0.0.1:9222');
    expect(version.browserGuid).toBe('guid-1');
    expect(version.product).toBe('Chrome/131.0.6778.86');
    expect(version.webSocketDebuggerUrl).toContain('guid-1');
  });

  it('throws RemoteCdpError on a non-ok HTTP status', async () => {
    const guidByOrigin = new Map([
      [
        'http://127.0.0.1:9222',
        { origin: 'http://127.0.0.1:9222', browserGuid: 'guid-1', reachable: false },
      ],
    ]);
    const client = new RemoteCdpClient({ fetchImpl: fakeFetch(guidByOrigin) });
    await expect(client.fetchVersion('http://127.0.0.1:9222')).rejects.toThrow(RemoteCdpError);
  });
});

describe('RemoteCdpClient command send/receive', () => {
  it('sends a browser-scoped command with no sessionId and resolves on the matching id', async () => {
    const socket = new FakeRemoteWebSocket();
    installDefaultResponder(socket);
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');
    const result = await client.sendBrowser('Browser.getVersion');
    expect(result).toEqual({});
    expect(socket.lastSent('Browser.getVersion')?.sessionId).toBeUndefined();
  });

  it('attachFirstPage finds a page target, attaches with flatten:true, and remembers the session id for sendPage', async () => {
    const socket = new FakeRemoteWebSocket();
    installDefaultResponder(socket, { pageTargets: ['page-1'] });
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');

    const sessionId = await client.attachFirstPage();
    expect(sessionId).not.toBeNull();
    expect(socket.lastSent('Target.attachToTarget')?.params).toMatchObject({
      targetId: 'page-1',
      flatten: true,
    });

    await client.sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
    });
    expect(socket.lastSent('Emulation.setDeviceMetricsOverride')?.sessionId).toBe(sessionId);
  });

  it('attachFirstPage returns null when the remote browser reports no page target', async () => {
    const socket = new FakeRemoteWebSocket();
    installDefaultResponder(socket, { pageTargets: [] });
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');
    expect(await client.attachFirstPage()).toBeNull();
  });

  it('rejects a command with RemoteCdpError when Chrome answers with a protocol error', async () => {
    const socket = new FakeRemoteWebSocket();
    socket.autoRespond = (msg) =>
      socket.emitError(msg.id, { code: -32601, message: "'Nope.method' wasn't found" });
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');
    await expect(client.sendBrowser('Nope.method')).rejects.toThrow(RemoteCdpError);
  });

  it('rejects every in-flight command when the socket closes', async () => {
    const socket = new FakeRemoteWebSocket();
    socket.autoRespond = null; // never answer, so the command stays in flight
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');
    const pending = client.sendBrowser('Browser.getVersion');
    socket.simulateRemoteClose();
    await expect(pending).rejects.toThrow(RemoteCdpError);
  });
});

describe('RemoteCdpClient.onClose', () => {
  it('reports unexpected=false when close() itself requested the close', async () => {
    const socket = new FakeRemoteWebSocket();
    installDefaultResponder(socket);
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');

    let observed: boolean | null = null;
    client.onClose((unexpected) => {
      observed = unexpected;
    });
    client.close();
    expect(observed).toBe(false);
  });

  it('reports unexpected=true when the remote side closes without close() being called', async () => {
    const socket = new FakeRemoteWebSocket();
    installDefaultResponder(socket);
    const client = new RemoteCdpClient({ wsFactory: fakeWebSocketFactory(socket) });
    await client.connect('ws://127.0.0.1:9222/devtools/browser/guid-1');

    let observed: boolean | null = null;
    client.onClose((unexpected) => {
      observed = unexpected;
    });
    socket.simulateRemoteClose();
    expect(observed).toBe(true);
  });
});
