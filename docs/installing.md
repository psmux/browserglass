# Installing and consuming BrowserGlass

## Status right now

Nothing under `@browserglass/*` is on the npm registry yet. `npm view
@browserglass/server`, and the same for `react`, `cli`, `automation` and
`embed`, all return a plain 404. None of the `npm install`, `pnpm add` or
`yarn add` lines below will resolve today. The only route into this code
right now is cloning the repository and building it, as
[`quickstart.md`](./quickstart.md) walks through.

The rest of this section describes the dist-tag policy these packages will
publish under once the first release goes out. It is the plan, not the
current state, and it is written here so the policy is settled before the
first publish rather than decided at the moment of it.

## Status of these packages, once published

Every package will publish as `0.1.0-alpha.0` under the npm dist-tag **`alpha`**, never
`latest`. That is deliberate. A plain `npm install @browserglass/server` will not
resolve until someone leaves the alpha line on purpose. If you want the alpha, ask for
it by name.

```
npm install @browserglass/server@alpha @browserglass/react@alpha
```

```
pnpm add @browserglass/server@alpha @browserglass/react@alpha
```

```
yarn add @browserglass/server@alpha @browserglass/react@alpha
```

Treat everything in the `0.1.0-alpha.x` line as movable. The wire protocol, the
capability enum, and the lease semantics are all still changing, and an alpha bump may
break any of them without a major version.

## Which packages you actually need

Two, for an ordinary application:

| Package | Where it runs | What it is |
| --- | --- | --- |
| `@browserglass/server` | Your Node server | `createBrowserGlass()`, the WebSocket loop, auth, capability enforcement |
| `@browserglass/react` | The browser | `<BrowserGlass />` and the hooks |

If you are not using React, take `@browserglass/client` instead (framework agnostic), or
`@browserglass/embed` for a `<browser-glass>` custom element you can drop into a plain
HTML page with one script tag.

The rest are transitive or optional:

* `@browserglass/protocol`, `@browserglass/core`, `@browserglass/router` come in as
  dependencies of `server`. You do not install them directly.
* `@browserglass/runtime-host` is the real Chrome runtime. `runtime-docker`,
  `runtime-k8s` and `runtime-remote` are alternates.
* `@browserglass/store-sqlite` is persistence. `store-postgres` is the alternate.
* `@browserglass/cli` gives you the `bgls` binary: `bgls serve`, `bgls doctor`,
  `bgls inspect`, `bgls instances`, `bgls swarm run`, and `bgls mcp`.
* `@browserglass/automation` is the automation client and a real MCP server: a
  40-tool manifest covering driving, locators, a whole-page `bg_page_map`
  inventory, diagnostics, and `bg_swarm_*` for parallel browsers. `bgls mcp`
  (from `@browserglass/cli`) is the launcher; see
  [`../docs/quickstart.md`](../docs/quickstart.md) for the JSON config an MCP
  client pastes in to run it. Not on Node?
  [`clients/python`](../clients/python) is a Python port of this same client over the
  same wire protocol: `pip install -e clients/python` from this monorepo, or
  `pip install browserglass` once published.

`@browserglass/conformance` is **not published**. It is the internal golden-vector and
contract suite, marked `private` and listed under `ignore` in `.changeset/config.json`.

## Node and module formats

Node 22 or newer, declared in `engines` on every package.

`protocol`, `core`, `router`, `server`, `automation`, both stores and all four runtimes
ship dual ESM and CJS, with separate type declarations per format
(`dist/index.d.ts` for `import`, `dist/index.d.cts` for `require`). `client`, `react`,
`embed` and `cli` are ESM only.

Both entry points are exercised in CI, so `import` and `require` should both work under
`"moduleResolution": "node16"` or `"bundler"`.

## Publishing (maintainers)

**Publish with pnpm. Never with npm or yarn classic.**

Sibling dependencies are declared using pnpm's `workspace:^` protocol. pnpm rewrites
those to a real semver range while building the tarball; npm and yarn copy the literal
string through, and then every consumer fails with `EUNSUPPORTEDPROTOCOL`. Each package
carries a `prepublishOnly` guard (`scripts/guard-publisher.mjs`) that refuses to run
under anything but pnpm, so the mistake fails loudly rather than reaching the registry.

Verify the rewrite for yourself at any time:

```
pnpm run build
pnpm run check:packed
```

That packs every publishable package, opens the manifest inside each tarball, and fails
on a surviving `workspace:` range, a dependency on a private package, a missing LICENSE,
or a leftover `0.0.0` placeholder.

To cut a release:

```
pnpm changeset                  # describe the change
pnpm changeset version          # bumps within the alpha pre-mode line
pnpm install                    # refresh the lockfile
git commit -am "release: ..."
git tag v0.1.0-alpha.1
git push --follow-tags
```

The `v*` tag triggers `.github/workflows/publish.yml`, which reruns typecheck, build, the
dependency gate, publint, `check:packed` and the tests before it publishes anything, then
runs `pnpm -r publish --access public --provenance`.

Leaving alpha is a deliberate, separate act: `pnpm changeset pre exit`, then change
`publishConfig.tag` away from `alpha` on every package.

## The LICENSE

Apache 2.0, one copy at the repository root. There is no per-package `LICENSE` file on
disk; pnpm copies the root license into each tarball at pack time, which
`check:packed` asserts. This works only because pnpm is the publisher, which is one more
reason the guard exists.
