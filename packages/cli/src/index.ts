/**
 * `@browserglass/cli`: the `bgls` command-line tool. Most consumers run
 * the `bgls` binary (`package.json`'s `bin.bgls`, built from `bin.ts`)
 * directly; this entry point exists for a host process that wants to
 * embed the same command tree (`runCli`) or reuse the embedded-gateway
 * assembly `bgls serve`/`bgls doctor --deep` are themselves built on
 * (`buildEmbeddedGateway`).
 */

export { runCli } from './cli.js';
export { buildEmbeddedGateway, DEFAULT_APP_ID, DEFAULT_TENANT_ID } from './gateway.js';
export type { EmbeddedGateway, EmbeddedGatewayOptions } from './gateway.js';
