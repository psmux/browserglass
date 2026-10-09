#!/usr/bin/env node
/**
 * Refuses to publish under any package manager other than pnpm.
 *
 * Every BrowserGlass package declares its sibling dependencies with pnpm's
 * `workspace:^` protocol. pnpm rewrites those to a real semver range when it
 * builds the tarball. npm and yarn classic do not: they copy the literal
 * string `workspace:^` into the published manifest, and every consumer then
 * fails with EUNSUPPORTEDPROTOCOL.
 *
 * `prepublishOnly` runs on `npm publish`, `yarn publish` and `pnpm publish`
 * alike, so this is the one place that catches the mistake before the tarball
 * reaches a registry. It deliberately does not run on `npm pack`, which is
 * harmless.
 *
 * Verify the rewrite yourself at any time:
 *   pnpm --filter @browserglass/client pack --pack-destination /tmp
 *   tar -xzOf /tmp/browserglass-client-*.tgz package/package.json
 */
const agent = process.env.npm_config_user_agent ?? '';

if (!agent.startsWith('pnpm')) {
  const seen = agent === '' ? '(no npm_config_user_agent set)' : agent;
  console.error(
    [
      '',
      'REFUSING TO PUBLISH: this package must be published with pnpm.',
      '',
      `  package manager seen: ${seen}`,
      '',
      "Sibling dependencies here use pnpm's `workspace:^` protocol. Only pnpm",
      'rewrites that to a real semver range at pack time. Publishing with npm or',
      'yarn ships the literal string, and every consumer then fails to install',
      'with EUNSUPPORTEDPROTOCOL.',
      '',
      'Use instead, from the repository root:',
      '',
      '  pnpm -r publish --access public --tag alpha',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
