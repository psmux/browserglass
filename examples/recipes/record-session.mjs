// Record what a browser shows while a script drives it.
//
//   node examples/recipes/record-session.mjs
//
// A recording is written by the gateway, to its own --recordings-dir, as
// frames plus a timing index. It never travels over this connection. To
// get the frames (or a video) out afterwards, use the CLI on the machine
// running the gateway:
//
//   pnpm bgls record list   --dir <recordings-dir>
//   pnpm bgls record export <recordingId> --dir <recordings-dir> --out out/frames
//   pnpm bgls record export <recordingId> --dir <recordings-dir> --out out/frames --video out/session.mp4
//
// --video needs the ffmpeg plugin installed once (see README.md in this folder).
// Start the gateway with --recordings-dir if you want recordings that outlive
// it; the default is a private temp directory the CLI cannot find later.

import { AGENT_CAPS, openBrowser } from './lib/gateway.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recording needs `capture` and `download` together: it makes a file that
// outlives the session, which is what `download` stands for.
const { client, done } = await openBrowser({ caps: [...AGENT_CAPS, 'download'], sub: 'recorder' });
try {
  await client.acquireControl();
  await client.navigate('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'load' });

  const rec = await client.startRecording();
  console.log(`recording ${rec.recordingId} started`);

  // A few things worth watching back.
  await sleep(1000);
  await client.scroll({ dy: 600 });
  await sleep(1000);
  await client.navigate('https://en.wikipedia.org/wiki/Web_browser', { waitUntil: 'load' });
  await sleep(1500);
  await client.scroll({ dy: 900 });
  await sleep(1500);

  const stopped = await client.stopRecording(rec.recordingId);
  const seconds = ((stopped.stoppedAtMs - stopped.startedAtMs) / 1000).toFixed(1);
  console.log(
    `stopped: ${stopped.framesWritten} frames over ${seconds} s, failed=${stopped.failed}`,
  );

  // What this session knows about. For anything after the session ends,
  // use `bgls record list`, which reads the files on disk.
  for (const r of await client.listRecordings()) {
    const state = r.stoppedAtMs ? 'stopped' : 'running';
    console.log(`listed: ${r.recordingId} (${state}, ${r.framesWritten} frames)`);
  }
  console.log(
    `export with: pnpm bgls record export ${rec.recordingId} --dir <recordings-dir> --out out/frames`,
  );
} finally {
  await done();
}
