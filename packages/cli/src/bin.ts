#!/usr/bin/env node
/**
 * The `bgls` executable entry point (`package.json`'s `bin.bgls`).
 * Everything else lives in `cli.ts`; this file exists only so the shebang
 * is the very first line of a dedicated tsup entry, never mixed into the
 * library entry point (`index.ts`) a programmatic consumer might import.
 */
import { runCli } from './cli.js';

await runCli();
