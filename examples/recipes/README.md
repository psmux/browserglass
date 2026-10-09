# Recipes

Small scripts that each do one real job with BrowserGlass. Every one of them was run against a live gateway before it went in here, and the output shown under each is from those runs.

## Setup

From the repo root, after `pnpm install` and `pnpm -r build`:

```sh
# terminal 1: the gateway
pnpm bgls serve --listen 127.0.0.1:7799

# terminal 2: point the recipes at it
export BGLS_URL=http://127.0.0.1:7799/browserglass   # this is the default
export BGLS_ADMIN_TOKEN=$(pnpm -s bgls token)
```

Run the token command in the folder where `bgls serve` was started (it reads `bgls-data/dev-session.json`), or set `BGLS_DATA_DIR` to that folder. The token lasts 10 minutes. When a recipe fails with `E_TOKEN_EXPIRED`, run the export line again. `pnpm -s bgls token --ttl 900` gives you the maximum of 15.

Every recipe starts its own headless Chrome with a throwaway profile and ends it when it finishes, except `persistent-login.mjs`, whose whole point is a profile that stays. Files land in `examples/recipes/out/`, which git ignores.

The Node recipes import the workspace build by relative path, so there is nothing extra to install. `lib/gateway.mjs` holds the shared part: start a browser, mint a token scoped to it, connect, release. In your own project you would import from `@browserglass/automation` instead.

## The recipes

| Recipe | What it does | Run |
|---|---|---|
| [`parallel-screenshots.mjs`](parallel-screenshots.mjs) | Nine browsers at once with `BrowserSwarm`, one screenshot each | `node examples/recipes/parallel-screenshots.mjs` |
| [`scrape-quotes.mjs`](scrape-quotes.mjs) | Quotes and authors from quotes.toscrape.com, two pages, clicking Next | `node examples/recipes/scrape-quotes.mjs > examples/recipes/out/quotes.json` |
| [`fill-form.mjs`](fill-form.mjs) | Fills and submits httpbin's pizza order form by label, checks what the server got | `node examples/recipes/fill-form.mjs` |
| [`persistent-login.mjs`](persistent-login.mjs) | A cookie survives into a second browser on the same profile key | `node examples/recipes/persistent-login.mjs` |
| [`human-in-the-loop.mjs`](human-in-the-loop.mjs) | The agent stops for a person to type a password, then carries on | `node examples/recipes/human-in-the-loop.mjs --simulate-human` |
| [`save-pdf.mjs`](save-pdf.mjs) | A Wikipedia article as a PDF | `node examples/recipes/save-pdf.mjs [url]` |
| [`block-requests.mjs`](block-requests.mjs) | Blocks every image and a URL pattern with the request gate, counts what it stopped | `node examples/recipes/block-requests.mjs` |
| [`record-session.mjs`](record-session.mjs) | Records a short browsing session, then exports frames or a video with the CLI | `node examples/recipes/record-session.mjs` |
| [`python/quickstart.py`](python/quickstart.py) | Navigate, read text, screenshot, from the Python client | `python examples/recipes/python/quickstart.py` |
| [`mcp.md`](mcp.md) | BrowserGlass as tools for Claude Code or Claude Desktop | read it |

## What each one printed

**parallel-screenshots.mjs**

```
9 browsers up in 13845 ms
ok    shot-1-example.com.png (1422x748, 37 KB)
ok    shot-2-en.wikipedia.org.png (1422x748, 210 KB)
...
ok    shot-9-github.com.png (1422x748, 91 KB)
9/9 screenshots in 20422 ms, saved to out/
```

The page size comes from the gateway, not the script: one gateway run here gave 762x428 pages, another 1422x748. Asking for `browser.viewport` on a headless acquire is accepted and echoed back in `effectiveSpec`, but the page does not render at that size in this build, so the recipe does not pretend to set it.

**scrape-quotes.mjs** (progress on stderr, JSON on stdout)

```
page map: 136 actionable nodes, 55 of them links
page 1: 10 quotes
page 2: 10 quotes
```

```json
[
  {
    "page": 1,
    "text": "“The world as we have created it is a process of our thinking. It cannot be changed without changing our thinking.”",
    "author": "Albert Einstein",
    "tags": ["change", "deep-thoughts", "thinking", "world"]
  },
  ...
]
```

**fill-form.mjs**

```
fields filled and verified: 4/4
server received: {"comments":"Ring the bell twice.","custemail":"ada@example.com","custname":"Ada Lovelace","custtel":"555 0100","delivery":"","size":"medium","topping":"mushroom"}
PASS: the order went through as typed
```

**persistent-login.mjs**

```
run 1 (inst_...): cookies now { demo: '1791555440910' }
waiting 35 s for Chrome to write its cookie store...
run 2 (inst_...): cookies now { demo: '1791555440910' }
PASS: the cookie survived the restart
```

Two things this recipe learned the hard way. A cookie with no expiry is a session cookie, and no profile keeps those. And on Windows the gateway ends Chrome with `taskkill`, which skips Chrome's last write of its cookie store, so a cookie set in the final 30 seconds or so before release is lost. The recipe waits that out.

**human-in-the-loop.mjs --simulate-human**

```
[agent] filled the username, the password is for a person to type
[agent] waiting for a person. Viewer settings:
          url:   ws://127.0.0.1:7799/browserglass/socket
          token: eyJhbGciOiJFZERTQSIsInR5... (full token in out/human-token.txt)
[agent] stood down (taken, voluntary), by the agent itself, human=false
[person] took control
[agent] a person has control, waiting for them to finish
[person] logged in, handing back
[agent] control is back. logged in: true
[agent] carrying on. First quote on the page: “The world as we have created it is ...”
```

Without `--simulate-human` the agent waits for a real person. Give them the URL and token above in any page that shows the live browser (a `<browser-glass>` element, the React component, or `examples/embed-demo`); clicking into the stream takes control, and handing it back lets the agent continue.

**save-pdf.mjs**

```
https://en.wikipedia.org/wiki/Web_browser
saved out/article.pdf, 674 KB, via download link
starts with "%PDF-1.4"
```

Anything over 32 KB comes back as a single use link, `/v1/downloads/<token>`, relative to `BGLS_URL`. On a gateway that has never downloaded anything, that path can fail with `ENOENT` because the downloads folder was never created. Starting the gateway with `BGLS_DOWNLOAD_DIR` set to a folder that exists avoids it.

**block-requests.mjs**

```
gate armed with 2 rules
blocked 23 requests: 20 images, 3 stylesheets
  e.g. Image https://books.toscrape.com/media/cache/2c/da/2cdad67c44b002e7ead0cc35693c0e8b.jpg
  e.g. Stylesheet https://books.toscrape.com/static/oscar/css/styles.css
page reports 20 of 20 <img> elements with no pixels
saved out/blocked-images.png (no covers, no styling)
```

**record-session.mjs**

```
recording rec_... started
stopped: 25 frames over 6.2 s, failed=false
listed: rec_... (stopped, 25 frames)
```

Start the gateway with `--recordings-dir` so the CLI can find the files afterwards, then:

```sh
pnpm bgls record list   --dir <recordings-dir>
pnpm bgls record export <recordingId> --dir <recordings-dir> --out examples/recipes/out/frames
```

That gives you numbered JPEG frames and a `manifest.json` with the timing. For a video there is an ffmpeg plugin:

```sh
pnpm build:plugins
pnpm bgls plugins add ./plugins/plugin-video-export
pnpm bgls record export <recordingId> --dir <recordings-dir> --out examples/recipes/out/frames --video examples/recipes/out/session.mp4
```

In this build the plugin fails on frames with an odd height (`height not divisible by 2`), which is most of them. Until that is fixed, ffmpeg directly does the job:

```sh
ffmpeg -framerate 4 -i examples/recipes/out/frames/%08d.jpg \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -pix_fmt yuv420p examples/recipes/out/session.mp4
```

**python/quickstart.py**

```
browser inst_... is ready
navigated to https://example.com/
page text: This domain is for use in documentation examples without needing permission. ...
saved out/python-shot.png (1422x748)
released: terminated
```

## Known rough edges these recipes work around

* Locator verbs (`click`, `fill`, `waitFor` with `css=`, `label=`, `text=` or `role=` selectors) currently fail against a live gateway with "script source is 34582 bytes, over the 32768 byte ceiling". The fix is on its own branch. `scrape-quotes`, `fill-form` and `human-in-the-loop` use those verbs, because that is the API you should write against.
* A plain release only detaches you while the gateway still counts another viewer, and a socket you closed a moment ago can still be counted, so the browser keeps running. `lib/gateway.mjs` releases with `force=true` for that reason, and retries, since on Windows a terminate sometimes answers `E_TERMINATE_FAILED` once and then succeeds.
* `navigate()` can return before `document.readyState` is `complete` on a busy machine. Recipes that read or capture the page right after navigating wait for it explicitly.
