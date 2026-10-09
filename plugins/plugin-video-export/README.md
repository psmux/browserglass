# `@browserglass/plugin-video-export`

The reference `frame-encoder` plugin (see `docs/plugins.md`). It
turns a recording's exported frames (the JPEG/PNG files plus
`manifest.json` that `bgls record export` already writes) into a video
file, by driving a system `ffmpeg`.

This is a real, separate npm project, deliberately excluded from the root
`pnpm-workspace.yaml`, the same way `examples/nextjs-demo` is: it is a
plugin, not a BrowserGlass workspace package, so it must not be dragged
into `check-deps`, the workspace build, or the published package set.

## What it needs

A system `ffmpeg` on `PATH`, at `BGLS_FFMPEG_PATH`, or at one of a few
common per-platform install locations (`src/ffmpeg.ts`). Nothing else: no
`CdpBridge`, no session, no target id, no network access. `encode()` is a
pure file-to-file transform over frames a recording already wrote to disk
after the session that produced them ended.

Without ffmpeg, `probe()` reports `usable: false` and `encode()` reports
`outcome: 'unsupported'`, both with a `detail` string saying so. Neither
throws: a missing encoder is a normal, reportable outcome, never a crash.

## Build and test

```bash
npm install
npm run typecheck
npm run build   # -> dist/plugin.mjs, one file, zero runtime dependencies
npm run test
```

`npm run build` bundles everything except Node's own builtins into one
`dist/plugin.mjs`, so the sha512 `bgls plugins add` records for this
plugin covers every line that will execute.
