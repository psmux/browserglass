# PDF export

This is the reference for one question: **how do I get a page out of
BrowserGlass as a PDF, and what happens when that PDF is too big to hand
back on the socket that asked for it?** Everything below is read from the
source in this repository; the file and symbol behind each claim is named
so it can be re-derived when a later change makes it stale.

`page.pdf.get` and `page.pdf.got` are the wire messages behind it
(`packages/protocol/src/wire/messages/pdf.ts`), surfaced as
`AutomationClient.pdf()` in `@browserglass/automation`
(`packages/automation/src/client/AutomationClient.ts`) and as the `bg_pdf`
MCP tool.

## Calling it

```ts
import { AutomationClient } from '@browserglass/automation';

const client = await AutomationClient.connect({ endpoint, token });

const pdf = await client.pdf({ format: 'A4', printBackground: true });
// pdf.sizeBytes: the real, measured size of the finished file
// pdf.data:      base64, only set when the file was small enough to inline
// pdf.downloadId / pdf.url / pdf.expiresAt / pdf.sha256: set instead when it was not
```

Over MCP, the same call is `bg_pdf`:

```jsonc
{ "name": "bg_pdf", "arguments": { "targetId": "tgt_abc123", "format": "A4" } }
```

`format` is a named paper size (`Letter`, `Legal`, `Tabloid`, `Ledger`,
`A0` to `A6`, default `Letter`), mutually exclusive with an explicit
`widthInches`/`heightInches` pair. `landscape`, `printBackground`, `scale`
(0.1 to 2), the four `margin*Inches` fields, `pageRanges` (CDP's own
`'1-5, 8, 11-13'` syntax), and `headerTemplate`/`footerTemplate` all map
straight onto `Page.printToPDF`
(`page.pdf.get`, `PagePdfGet`, `wire/messages/pdf.ts`). No held control
lease is needed: rendering a PDF, like taking a screenshot, does not touch
the page.

## Gated on `capture`, not a new capability

A PDF is a render of the page the caller can already see, so it asks for
exactly the capability `target.capture` already needs
(`AutomationClient.pdf`'s own doc comment), never `evaluate`: the whole
argument for `evaluate` is that running script reads cookies, storage, and
tokens a rendered view of the page does not, and a PDF stays on the view
side of that line the same way a screenshot does. It also shares
`target.capture`'s own rate bucket rather than getting a fresh one to
budget separately.

## Size is the actual design problem

`target.capture` lets a caller ask for `delivery: 'auto' | 'inline' |
'url'` up front, because a screenshot's rough size is knowable before the
capture runs, bounded by `maxDimension` and the codec. A PDF has no
equivalent up-front signal: `Page.printToPDF` reports neither a page count
nor a byte estimate before it finishes composing the whole document. So
`page.pdf.get` carries no `delivery` field at all. The server renders the
PDF, measures what it actually produced, and reports whichever delivery
that size earned:

* **Below `MAX_INLINE_PDF_BYTES`** (32768 raw bytes, roughly 43.7 KiB once
  base64 inflates it, the identical ceiling `target.capture` uses for an
  inline screenshot): `pdf.data` is set, base64, no `data:` prefix.
* **At or above it**: `data` is absent and `downloadId`, `url`,
  `expiresAt`, and `sha256` are set instead, the identical shape
  `download.ready` already uses for a real browser download, reusing the
  same signed, short-lived, single-use URL mechanism
  (`@browserglass/server`'s `DownloadStore`) rather than inventing a
  second one for a PDF that happens to originate from this process
  instead of from the page.

**This deliberately diverges from `screenshot()`.** `AutomationClient
.screenshot()` refuses URL delivery outright when a caller asks for it,
because an oversized image is the rare case for a screenshot. That
argument does not hold for a PDF: any real page longer than a couple of
screens produces one well past the inline ceiling (a single embedded font
alone can be tens of kilobytes), so the download path is not a rare
fallback here, it is the common case, and it is fully built rather than
left as a documented gap.

## Fetching `pdf.url`

`pdf.url` from `AutomationClient.pdf()` is an absolute `http(s)` URL. GET
it with any HTTP client. No `Authorization` header is needed, because the
random token in the URL is the credential, and it works once: the first
GET consumes it, and it stops working at `expiresAt` (60 seconds by
default, `limits.downloadUrlTtlMs`) whether or not anyone fetched it.

```ts
const pdf = await client.pdf();
const bytes = pdf.data !== undefined
  ? Buffer.from(pdf.data, 'base64')
  : Buffer.from(await (await fetch(pdf.url!)).arrayBuffer());
```

What the gateway puts on the wire (`page.pdf.got.url`, and
`download.ready.url` for a real browser download) depends on whether
`publicUrl` is configured:

* With `publicUrl` set, it is already absolute:
  `<publicUrl origin><basePath>/v1/downloads/<token>`.
* Without it, it is a path from the host root that already includes the
  base path, `/browserglass/v1/downloads/<token>` under the default
  `basePath`. Resolve it against the gateway's origin
  (`new URL(url, 'http://127.0.0.1:7443')`), never by appending it to the
  base path.

`AutomationClient` (and the Python client's `wait_for_download`) does
that resolution for you against the origin its socket dialed, so callers
of those clients only ever see the absolute form. Only code reading the
raw wire message has to care. `DownloadStore.issueUrl` in
`packages/server/src/downloads/download-store.ts` builds the URL.

## The refusal, when there is nowhere to put the bytes

When the gateway has no download store configured at all, or the finished
file exceeds the store's own size ceiling, generation is refused outright
as `bgls.error.capture.too_large` rather than the reply silently omitting
both `data` and `downloadId`. A caller must never have to infer failure
from an empty-looking success.

## What this does not do

There is no thumbnail or preview tier the way a screenshot's `maxDimension`
gives you a cheap small render; a PDF is either the whole rendered document
inline or the whole rendered document behind a download link. There is
also no page-count or byte-size estimate available before the render
finishes, for the reason above: a caller that needs to bound cost has
`pageRanges` to narrow what gets rendered, and the request's own
`timeoutMs` (default 45000 client side, following the server's own 30s
`Page.printToPDF` CDP budget plus headroom for the disk write and SHA-256
hash a large, download-bound PDF needs before it can reply at all).
