/**
 * Helpers for turning one `CdpEndpoint.url` (`http://…`, `ws://…`, or
 * `unix://…`, per `@browserglass/protocol`'s `domain/runtime.ts`) into the
 * HTTP origin `probeCdpIdentity` needs to `GET <origin>/json/version`.
 */

/**
 * Thrown when an endpoint URL's transport is not one this package's CDP
 * client can reach. `unix://` is a real, protocol-declared `CdpEndpoint`
 * form (for `runtime-docker`), but reaching it needs an `AF_UNIX`-aware
 * HTTP client this package does not carry.
 */
export class UnsupportedEndpointTransportError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(
      `runtime-remote cannot reach endpoint URL "${url}": only http(s):// and ws(s):// transports are supported`,
    );
    this.name = 'UnsupportedEndpointTransportError';
    this.url = url;
  }
}

/**
 * Derives the HTTP origin (no trailing slash, no path) `/json/version` is
 * fetched against, from any of the three `CdpEndpoint.url` forms. A
 * `ws://host:port/devtools/browser/<guid>` URL (the shape `attach()`
 * receives when a caller already knows the browser's websocket endpoint)
 * has its path dropped and its scheme mapped to the matching `http` form.
 */
export function deriveHttpOrigin(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/\/+$/, '');
  }
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    const httpScheme = url.startsWith('wss://') ? 'https://' : 'http://';
    const rest = url.slice(url.indexOf('://') + 3);
    const hostPort = rest.split('/')[0] ?? rest;
    return `${httpScheme}${hostPort}`;
  }
  throw new UnsupportedEndpointTransportError(url);
}
