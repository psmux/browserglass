import type { WebSocketConstructorLike } from '@browserglass/client';
import type { PdfPaperFormat } from '@browserglass/protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AutomationClient } from '../client/AutomationClient.js';
import { AutomationError } from '../errors.js';
import type { LocatorMatch, SelectOptionSpec } from '../locator/types.js';
import { BrowserSwarm } from '../swarm.js';
import type { SwarmAcquireContext, SwarmAcquireResult, SwarmMember } from '../swarm.js';
import type { AutomationEvents, UploadFileInput } from '../types.js';
import {
  type McpToolResult,
  formatPageMapCapture,
  formatToolError,
  formatToolResult,
} from './format.js';

/**
 * The `targetId`/`swarmId`/`member` argument trio every single-target tool
 * accepts, so a caller can point one tool at either the bound client
 * (`targetId`, or nothing for the client's own bound target) or one member
 * of an open swarm (`swarmId` plus `member`) without needing a second,
 * swarm-only copy of the same tool. See {@link resolveTarget} for how these
 * three resolve to one client.
 */
function targetSelectorProperties(): Record<string, object> {
  return {
    targetId: {
      type: 'string',
      description:
        "Tab id. Defaults to the bound target, or (with swarmId) to that member's own target.",
    },
    swarmId: {
      type: 'string',
      description:
        'Acts on one member of this open swarm instead of the bound client. Get a swarmId from bg_swarm_open or bg_swarm_list.',
    },
    member: {
      type: ['number', 'string'],
      description:
        'Which member of swarmId to act on: a member index (number, see bg_swarm_list) or an instanceId (string). Required when swarmId is given.',
    },
  };
}

/**
 * The MCP tool manifest, plain JSON Schema per the MCP `tools/list` wire
 * shape. Built against the low-level `Server` class rather than the SDK's
 * higher-level `McpServer` so this package adds exactly one dependency
 * (`@modelcontextprotocol/sdk` itself): `McpServer.registerTool()` requires
 * a Zod (or Zod-compatible) input schema, and a raw JSON Schema tool
 * manifest needs none.
 *
 * Three groups of tools, sharing the argument shape above through
 * {@link resolveTarget}:
 *
 * - The original single-target tools (`bg_status`, `bg_read_page`,
 *   `bg_click`, `bg_type`, `bg_control`), plus `bg_navigate`, `bg_back`,
 *   `bg_forward`, `bg_reload`, `bg_stop`, `bg_press_key`, `bg_scroll`,
 *   `bg_screenshot`, `bg_wait_for_navigation`, and `bg_tabs`, filling out
 *   the driving and locomotion surface `AutomationClient` already has.
 *   `bg_click` also accepts a `selector`, in which case it goes through
 *   the locator surface below rather than dispatching at a raw coordinate.
 *   Every one of these also accepts `swarmId`/`member`, so an agent never
 *   needs a second tool just because its target happens to live inside a
 *   swarm rather than being the server's bound client.
 * - The locator surface (`bg_evaluate`, `bg_resolve`, `bg_wait_for`,
 *   `bg_wait_for_text`, `bg_get_text`, `bg_get_attribute`, `bg_is_checked`,
 *   `bg_get_html`, `bg_scroll_into_view`, `bg_fill`, `bg_select`), thin
 *   wrappers over the `AutomationClient` methods of the same (unprefixed)
 *   name; see `../client/AutomationClient.ts` and `../locator/types.ts` for
 *   what each one actually does. `bg_resolve` is the one worth calling out:
 *   there is no element-handle API on this surface (`AutomationClient.resolve`'s
 *   own doc explains why), so `bg_resolve` is the primitive an agent driving
 *   over MCP reaches for to decide where to click or whether a field is
 *   fillable, in the one round trip an MCP call already costs. Every one of
 *   these needs the `evaluate` capability, which is deliberately absent
 *   from every role bundle and has to be granted on the token explicitly.
 * - Swarm lifecycle (`bg_swarm_open`, `bg_swarm_list`, `bg_swarm_grow`,
 *   `bg_swarm_shrink`, `bg_swarm_close`) and the fan-out tool
 *   (`bg_swarm_run`), built on `BrowserSwarm` (`../swarm.js`): see that
 *   file and `PARALLELISM.md` for what it does and does not guarantee.
 * - Diagnostics (`bg_diagnostics_subscribe`, `bg_read_console`,
 *   `bg_read_network`, `bg_wait_for_network_idle`), reading the
 *   `devtools`-gated console/error/network feeds `AutomationClient.on()`
 *   delivers, buffered here since neither `AutomationClient` nor the wire
 *   protocol keeps any history of its own.
 * - `bg_page_map`, also `devtools`-gated rather than `evaluate`-gated (it
 *   runs no page script): a flat, indexed inventory of every actionable
 *   element in one round trip, the thing `bg_resolve` alone cannot give
 *   because it needs a selector to already be known. Its `action: 'stamp'`
 *   half is how an index from a capture becomes something `bg_resolve`/
 *   `bg_click` can address, over `AutomationClient.pageMap()` and
 *   `.stampPageMap()`; see the tool's own manifest description and
 *   `./format.js`'s `formatPageMapCapture()` for the rendering choices.
 * - `bg_recording`, one tool with `action: 'start' | 'stop' | 'list'`, the
 *   same one-tool-many-actions shape `bg_control`/`bg_tabs`/`bg_page_map`
 *   already use, over `AutomationClient.startRecording()`/
 *   `.stopRecording()`/`.listRecordings()`. Gated on BOTH `capture` AND
 *   `download` together, never on either alone: a recording is a durable
 *   file outliving this socket, the same authority `download` already
 *   gates for a real browser download, not merely the momentary render
 *   `capture` gates by itself. See those methods' own doc and
 *   `@browserglass/protocol`'s `wire/messages/recording.ts` module doc for
 *   why. This tool never hands back the recorded bytes; the recording is
 *   written to the gateway's own disk, and the `bgls` CLI (`bgls record
 *   list`/`export`, pointed at the same `--recordings-dir` the gateway
 *   used) is the only way to read one back, said plainly in the tool's own
 *   description so an agent that starts a recording is not left unable to
 *   find it later.
 */
export const AUTOMATION_MCP_TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'bg_status',
    description:
      'Current URL, title, loading state, and control-lease holder for a tab. Cheapest diagnostic call; safe to call constantly and does not require a held lease.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_read_page',
    description:
      'The visible text of the page (document.body.innerText), truncated to 2000 characters (the response reports the untruncated length). Built on the evaluate surface, so it requires the evaluate capability, which is not in any role bundle and has to be granted on the token explicitly; without it this reports a clean POLICY_DENIED naming what is missing. For anything past a quick read, bg_get_text (one element) or bg_resolve (find and inspect elements) are usually the better fit.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_click',
    description:
      'Clicks at a viewport CSS coordinate (x and y), or clicks the element a selector resolves to (selector); give one or the other, not both. The selector path goes through the same locator engine bg_resolve/bg_fill/bg_select use: it waits for the match to be actionable, scrolls it into view, and clicks it with real CDP input, in one round trip. Requires a held control lease either way: call bg_control with action "acquire" first. The selector path additionally requires the evaluate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        x: {
          type: 'number',
          description: 'Viewport CSS x, required alongside y. Give this or selector, not both.',
        },
        y: {
          type: 'number',
          description: 'Viewport CSS y, required alongside x. Give this or selector, not both.',
        },
        selector: {
          type: 'string',
          description:
            'The selector to click, the same >>-chained dialect bg_resolve accepts. Give this or x/y, not both. Requires the evaluate capability.',
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
        clickCount: { type: 'number', description: 'Default 1.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
          description: 'Modifier keys held down for the click. Default none.',
        },
      },
    },
  },
  {
    name: 'bg_type',
    description:
      'Types text into whatever element currently has focus. Requires a held control lease.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        text: { type: 'string', description: 'The text to type.' },
        humanLike: {
          type: 'boolean',
          description:
            'Default false. Paced, per-character typing that yields immediately if a human takes control back.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'bg_control',
    description:
      'Acquire, release, yield, or check the control lease. This is what lets the agent act at all when a human might be present. If any tool has just failed with LEASE_REVOKED, call this with action "yield_status" before doing anything else: it tells you whether a PERSON took the browser over, which is the one case where the right move is to stop rather than retry.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        action: {
          type: 'string',
          enum: ['acquire', 'release', 'status', 'yield', 'yield_status'],
          description:
            'acquire/release/status manage the lease. "yield" stands down deliberately: stop driving and hand the browser to whoever wants it, without waiting to be preempted. "yield_status" reports whether this browser has been taken over, by whom, whether they were a person, and the earliest time control may be requested again.',
        },
        reason: {
          type: 'string',
          description:
            'acquire: shown to a human viewer in the takeover prompt. yield: recorded as why the agent stood down.',
        },
        waitMs: {
          type: 'number',
          description: 'Default 30000; 0 fails immediately if busy. acquire only.',
        },
        durationMs: { type: 'number', description: 'Default 60000, server clamped. acquire only.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'bg_set_input_files',
    description:
      'Attaches one or more files to an <input type="file"> on the page, the equivalent of Playwright\'s set_input_files. This is how a form that asks for an invoice, a photo, or a document gets one. Give it a CSS selector for the file input and either paths on THIS machine (the usual case) or inline base64 content. The bytes are streamed to the machine running the browser first, because that browser cannot read this machine\'s disk. Requires the upload capability on the token; does not require a held control lease.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: {
          type: 'string',
          description:
            "CSS selector for the file input, for example input[type=file] or #attachment. Resolved against the page's main document; an input inside an iframe is not reachable.",
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Files to read from THIS machine (the machine running this MCP server) and send. Use this whenever the file exists locally; it is much cheaper than base64 in the tool call.',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The filename the page should see.' },
              dataBase64: { type: 'string', description: 'The file content, base64.' },
              mime: { type: 'string', description: 'Default application/octet-stream.' },
            },
            required: ['name', 'dataBase64'],
          },
          description:
            'Inline file content, for content this agent generated rather than read from disk. Prefer "paths" for anything that already exists as a file: a 200 KB PDF is 270 KB of base64 here.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'bg_navigate',
    description:
      'Navigates a tab to a URL and waits for the reply naming the page it landed on. Requires a held control lease on the target: call bg_control with action "acquire" first, or use bg_swarm_run\'s "navigate" action, which acquires and releases the lease for you.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        url: { type: 'string', description: 'The URL to navigate to.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'bg_screenshot',
    description:
      "A screenshot of a tab, returned as base64 image data in the result. Costs more than bg_status: it round trips through the browser's own capture pipeline. Does not require a held lease.",
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default png.' },
        fullPage: { type: 'boolean', description: 'Default false: just the viewport.' },
        maxDimension: {
          type: 'number',
          description: 'Downscales so neither side exceeds this many pixels, if given.',
        },
      },
    },
  },
  {
    name: 'bg_pdf',
    description:
      'Renders a tab as a PDF via the browser\'s own print pipeline (Page.printToPDF), not a screenshot stitched together. Does not require a held lease. A small PDF (well under 32KB, roughly a mostly-blank single page) comes back inline as base64 "data" in the result; any real page is larger than that and comes back instead as a "url" field, a short-lived (about 60s), single-use HTTP link this tool result does NOT fetch for you, so download it promptly rather than treating the result as the file itself. Costs more than bg_screenshot for anything but a trivial page: rendering and paginating a full document is slower than rasterising the current viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        format: {
          type: 'string',
          enum: ['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
          description:
            'Named paper size. Default Letter. Mutually exclusive with widthInches/heightInches.',
        },
        widthInches: {
          type: 'number',
          description: 'Explicit paper width, inches. Must be given together with heightInches.',
        },
        heightInches: {
          type: 'number',
          description: 'Explicit paper height, inches. Must be given together with widthInches.',
        },
        landscape: { type: 'boolean', description: 'Default false (portrait).' },
        printBackground: {
          type: 'boolean',
          description:
            "Whether CSS backgrounds print. Default false, matching Chrome's own print dialog.",
        },
        scale: { type: 'number', description: '0.1 to 2. Default 1.' },
        marginTopInches: { type: 'number' },
        marginBottomInches: { type: 'number' },
        marginLeftInches: { type: 'number' },
        marginRightInches: { type: 'number' },
        pageRanges: { type: 'string', description: 'e.g. "1-5, 8, 11-13". Default every page.' },
        headerTemplate: {
          type: 'string',
          description:
            'HTML for the page header. Setting either this or footerTemplate turns header/footer display on for both.',
        },
        footerTemplate: { type: 'string', description: 'HTML for the page footer.' },
      },
    },
  },
  {
    name: 'bg_recording',
    description:
      'Starts, stops, or lists a durable, disk-persisted recording of a tab\'s stream, written to the gateway\'s own disk, where it outlives this socket, this viewer, and this session. Requires BOTH the capture capability (the momentary render this tab already needs) AND the download capability (the durable-artifact authority a file that outlives the session needs): missing either is refused, and having only one is not enough. This tool never returns the recorded bytes: read a finished recording back with the bgls CLI ("bgls record list" / "bgls record export"), pointed at the same --recordings-dir the gateway was started with, not through this tool. "list" reports only what THIS live session\'s socket currently knows about, which forgets everything once the socket closes; it is not the same as what "bgls record list" sees on disk after the fact.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        action: {
          type: 'string',
          enum: ['start', 'stop', 'list'],
          description:
            '"start" begins recording the resolved target\'s stream. "stop" ends a recording, given the recordingId an earlier "start" returned. "list" reports every recording this session\'s socket currently knows about.',
        },
        recordingId: {
          type: 'string',
          description: 'stop only, required: the recordingId an earlier "start" returned.',
        },
        mode: {
          type: 'string',
          enum: ['live', 'thumbnail'],
          description:
            'start only. Default "live" (the full screencast). "thumbnail" pins the recording to the low-cost polling tier instead.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'bg_back',
    description:
      'Navigates one step back in the tab\'s history. Requires a held control lease: call bg_control with action "acquire" first.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_forward',
    description:
      'Navigates one step forward in the tab\'s history. Requires a held control lease: call bg_control with action "acquire" first.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_reload',
    description:
      'Reloads the tab. Requires a held control lease: call bg_control with action "acquire" first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        ignoreCache: {
          type: 'boolean',
          description: 'Default false. True bypasses the cache, the same as a hard reload.',
        },
      },
    },
  },
  {
    name: 'bg_stop',
    description:
      'Stops the tab\'s current navigation or load, the same as pressing a browser\'s stop button. Requires a held control lease: call bg_control with action "acquire" first.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_press_key',
    description:
      'Presses one key or key combo on whatever element currently has focus, for example "Enter", "Escape", or "Control+A". Requires a held control lease: call bg_control with action "acquire" first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        key: {
          type: 'string',
          description:
            'The key or combo to press, e.g. "Enter", "Tab", "Control+A". The final +-separated segment names the key itself.',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
          description:
            'Modifier keys held down for the press, on top of any already named in key. Default none.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'bg_scroll',
    description:
      'Dispatches a mouse wheel scroll at a viewport CSS point, default the viewport centre. Requires a held control lease: call bg_control with action "acquire" first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        x: {
          type: 'number',
          description:
            'Viewport CSS x the wheel event is dispatched at. Default the viewport centre.',
        },
        y: {
          type: 'number',
          description:
            'Viewport CSS y the wheel event is dispatched at. Default the viewport centre.',
        },
        dx: { type: 'number', description: 'Horizontal scroll delta. Default 0.' },
        dy: { type: 'number', description: 'Vertical scroll delta. Default 0.' },
      },
    },
  },
  {
    name: 'bg_wait_for_navigation',
    description:
      "Waits for the tab's next navigation to finish loading, then reports where it landed. Useful after bg_back, bg_forward, or bg_reload, which (like bg_navigate) already wait for their own reply naming the page but can be followed by a further client side redirect. Does not require a held lease.",
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        timeoutMs: {
          type: 'number',
          description: "Deadline, milliseconds. Default the client's own default timeout.",
        },
      },
    },
  },
  {
    name: 'bg_tabs',
    description:
      'Lists, opens, activates, or closes tabs. "list" reports every tab on the connection; "open" creates one and returns it; "activate" and "close" act on the tab named by tabId (from a prior "list" or "open"), which is a different thing from the targetId/swarmId/member trio: those pick which connection this call itself runs over, not which tab the action applies to. Requires the tabs.manage capability, which is in every role bundle except observer. Does not require a held control lease.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        action: {
          type: 'string',
          enum: ['list', 'open', 'activate', 'close'],
          description: 'Which tab operation to run.',
        },
        url: {
          type: 'string',
          description: 'open only. URL for the new tab. Default about:blank.',
        },
        background: {
          type: 'boolean',
          description:
            "open only. Default false, which also activates the new tab; true leaves the caller's current tab focused.",
        },
        tabId: {
          type: 'string',
          description:
            'activate and close only. The tab to act on, from a prior bg_tabs action "list" or "open".',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'bg_evaluate',
    description:
      'Runs a JavaScript EXPRESSION in the page and returns the result by value, for example "document.title" or "document.querySelectorAll(\'a\').length". The result must be JSON-representable: an element or any other live object comes back as a thrown error naming what the value was, not a handle, because there is no element-handle API on this surface (see bg_resolve). Requires the evaluate capability, which is not in any role bundle and has to be granted explicitly on the token; without it this reports a clean POLICY_DENIED naming what is missing. Reach for bg_resolve, bg_click, bg_fill, or bg_select before this: they already cover finding and acting on an element without an ad hoc script.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        expression: {
          type: 'string',
          description:
            'A JavaScript expression, evaluated once and returned by value. Not a function body: write "document.title", not "function() { return document.title }".',
        },
        awaitPromise: {
          type: 'boolean',
          description:
            'Default true: a returned promise is settled and its value returned, and a rejection surfaces as a thrown error. Set false to get the promise description back instead, which is almost never what is wanted.',
        },
        userGesture: {
          type: 'boolean',
          description:
            'Default false. Runs with a transient user activation, which needs the control capability on top of evaluate: it is a claim to be acting as the person at the keyboard.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Evaluation deadline. Default 30000, capped server side at 120000.',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'bg_resolve',
    description:
      'Finds every element a selector matches and reports, for each, its rect, all five actionability answers (attached, visible, enabled, stable, hitTestOk), and what is sitting on top of it (occludedBy), in ONE round trip. This is the primitive an agent driving over MCP should reach for: there is no element-handle API on this surface, so bg_resolve is how an agent decides where to click or whether a field is actually fillable, rather than guessing from a screenshot or paying for a second tool call. Matching nothing is an ordinary answer (0 matches), not an error; matching many is also ordinary, there is no strict mode here. Selector dialect: css= (default), text= (substring, case-insensitive; text="exact phrase" for an exact match), xpath= (accepted only as a chained segment), label= (aria-labelledby, then aria-label, then label[for], then a wrapping label, first non-empty wins), ref= (a stamp from an earlier bg_resolve/bg_click/bg_fill/bg_select), visible=; segments chain with \'>>\', e.g. "input#first >> xpath=ancestor::label[1]". Requires the evaluate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: {
          type: 'string',
          description:
            'The selector to resolve, for example "button[type=submit]" or "text=Submit application >> visible=true".',
        },
        limit: {
          type: 'number',
          description:
            'Cap on returned matches. Default 50; the total count is still reported even when it is truncated.',
        },
        stamp: {
          type: 'boolean',
          description:
            'Write a ref onto each match so a later tool call can address it as ref=<token>. Default true; set false on a page whose own scripts react to attribute mutations.',
        },
        stable: {
          type: 'boolean',
          description:
            'Measure rect stability across two animation frames. Default true; set false for a pure existence check, which does not need it.',
        },
        hitTest: {
          type: 'boolean',
          description: 'Hit-test each match at its centre, populating occludedBy. Default true.',
        },
        scroll: {
          type: 'boolean',
          description:
            'Scroll the match at scrollIndex into view before measuring, in the same evaluation. Default false.',
        },
        scrollIndex: {
          type: 'number',
          description: 'Which match to scroll to when scroll is set. Default 0.',
        },
        within: {
          type: 'string',
          description:
            'Resolve within an already-stamped element (a ref from an earlier call) rather than the whole document.',
        },
        textLimit: {
          type: 'number',
          description: "Truncate each match's reported text at this many characters. Default 200.",
        },
        timeoutMs: { type: 'number', description: 'Evaluation deadline. Default 30000.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'bg_wait_for',
    description:
      "Waits for a selector to reach a state (default visible; actionable additionally requires enabled, stable, and not occluded, which is what bg_click and bg_fill themselves wait for before acting). Held in the page with a MutationObserver rather than polled from here, so an 8 second wait costs one round trip and not eighty. On timeout the error names what was actually observed: which check failed, the element's rect, and what was on top of it. Requires the evaluate capability.",
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: {
          type: 'string',
          description: 'The selector to wait on; the same >>-chained dialect bg_resolve accepts.',
        },
        state: {
          type: 'string',
          enum: ['attached', 'detached', 'visible', 'hidden', 'actionable'],
          description: 'Default visible.',
        },
        timeoutMs: { type: 'number', description: 'How long to hold, milliseconds. Default 8000.' },
        pollMs: {
          type: 'number',
          description:
            'The in-page backstop interval, milliseconds. Default 100; this costs nothing on the socket, the DOM mutation observer does the real work.',
        },
        index: {
          type: 'number',
          description:
            'Wait for this match specifically rather than for any of them, when the selector is known to match more than one element.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'bg_wait_for_text',
    description:
      'Waits until some element matching a PLAIN CSS selector contains the given text in its normalised, whitespace-collapsed textContent, then returns the text that matched. Case-insensitive substring match by default; pass exact true to require the whole normalised text to equal it rather than merely contain it. Unlike bg_wait_for/bg_resolve, this selector goes straight to querySelectorAll and is not the >>-chained locator dialect. Requires the evaluate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: {
          type: 'string',
          description:
            'A plain CSS selector, passed straight to querySelectorAll, not the >>-chained locator dialect.',
        },
        text: { type: 'string', description: 'The text to wait for.' },
        timeoutMs: {
          type: 'number',
          description: 'Overall deadline for the whole poll, milliseconds. Default 30000.',
        },
        pollingMs: { type: 'number', description: 'Milliseconds between polls. Default 100.' },
        exact: {
          type: 'boolean',
          description:
            'Require the whole normalised text to equal "text" rather than merely contain it. Default false. Both modes are case-insensitive.',
        },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'bg_get_text',
    description:
      "The rendered text (innerText) of the element a selector resolves to, Playwright's inner_text. One round trip: the read rides along on the resolver rather than following a separate bg_resolve call. Requires the evaluate capability.",
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: { type: 'string', description: 'The selector to read.' },
        index: {
          type: 'number',
          description:
            'Which match to read, when the selector matches more than one element. Default 0.',
        },
        timeoutMs: { type: 'number', description: 'Evaluation deadline. Default 30000.' },
        limit: {
          type: 'number',
          description: 'Truncate the returned text at this many characters, if given.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'bg_get_attribute',
    description:
      'One attribute of the element a selector resolves to, or null when the attribute is absent. Throws NOT_FOUND when the SELECTOR matched nothing, which is a different thing and must not be confused with a missing attribute. Requires the evaluate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: { type: 'string', description: 'The selector to read.' },
        name: {
          type: 'string',
          description: 'The attribute name, for example "href" or "aria-label".',
        },
        index: {
          type: 'number',
          description:
            'Which match to read, when the selector matches more than one element. Default 0.',
        },
        timeoutMs: { type: 'number', description: 'Evaluation deadline. Default 30000.' },
      },
      required: ['selector', 'name'],
    },
  },
  {
    name: 'bg_is_checked',
    description:
      'Whether the element a selector resolves to is checked: reads element.checked, falling back to aria-checked for widgets that are not real <input> elements. Requires the evaluate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: { type: 'string', description: 'The selector to read.' },
        index: {
          type: 'number',
          description:
            'Which match to read, when the selector matches more than one element. Default 0.',
        },
        timeoutMs: { type: 'number', description: 'Evaluation deadline. Default 30000.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'bg_get_html',
    description:
      "The page's full serialised markup, document.documentElement.outerHTML, truncated to 2000 characters (the response reports the untruncated length). Built on the evaluate surface, so it requires the evaluate capability, which is not in any role bundle and has to be granted on the token explicitly. For one element's markup rather than the whole page, bg_resolve or bg_get_text are usually the better fit.",
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_scroll_into_view',
    description:
      'Scrolls the element a selector resolves to into view and returns it as measured AFTER the scroll: rect, the five actionability booleans, and what is occluding it, the same trimmed shape bg_resolve reports. Does not click or otherwise act on the element. Requires the evaluate capability; does not require a held control lease.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: { type: 'string', description: 'The selector to scroll into view.' },
        index: {
          type: 'number',
          description:
            'Which match to act on, when the selector matches more than one element. Default 0.',
        },
        timeoutMs: { type: 'number', description: 'Evaluation deadline. Default 30000.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'bg_fill',
    description:
      'Fills a field: clicks it to focus (which also proves it is not covered), clears it, then types the value with real per-character key events by default, not Input.insertText, because the filtering comboboxes agents meet in practice (react-select style widgets and some enterprise form widgets) open and filter on keydown, which insertText never fires. Reads the value back afterward and reports whether it matches; a mismatch comes back as verified: false rather than thrown, because a masked or reformatting input (a phone field turning digits into "(555) 010-9999") is a legitimate outcome to inspect, not a failure. Stands down mid-word if a person takes the browser back, reporting how many characters were typed. Requires the evaluate AND control capabilities, and a held control lease: call bg_control with action "acquire" first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: { type: 'string', description: 'The selector for the field to fill.' },
        value: { type: 'string', description: 'The text to type.' },
        index: {
          type: 'number',
          description: 'Which match to act on, when the selector matches more than one element.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Overall deadline covering the wait, the resolve, and the read-back retries. Default 8000.',
        },
        mode: {
          type: 'string',
          enum: ['keys', 'insert'],
          description:
            'Default keys: real per-character key events. insert sends one Input.insertText, which is faster and silent to keydown-driven comboboxes.',
        },
        delayMs: {
          type: 'number',
          description:
            'Inter-character delay for mode keys, milliseconds. Default 0; set it (40 is a reasonable value) when a widget debounces its filtering.',
        },
        clear: { type: 'boolean', description: 'Clear the field first. Default true.' },
        click: { type: 'boolean', description: 'Click the element before typing. Default true.' },
        verify: {
          type: 'boolean',
          description:
            'Read the value back after typing and report whether it matches. Default true.',
        },
        strict: {
          type: 'boolean',
          description:
            'Throw when the value read back does not match, instead of returning verified: false. Default false. Use it for passwords and any field the page should not reformat.',
        },
        scroll: {
          type: 'boolean',
          description: 'Scroll the element into view before measuring. Default true.',
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'bg_select',
    description:
      'Sets a <select>\'s selection by value, by visible label, or by index, and reports what actually ended up selected. option accepts a bare string (shorthand for {value}, the common case), an object naming exactly one of value, label, or index, or an array of any of those for a <select multiple>. Every requested option is resolved against the <select>\'s own options before anything is written, so nothing is mutated when any of them is missing; the error then names both what was asked for and every option the <select> actually offers. Requires the evaluate AND control capabilities, and a held control lease: call bg_control with action "acquire" first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        selector: { type: 'string', description: 'The selector for the <select> to act on.' },
        option: {
          type: ['string', 'object', 'array'],
          description:
            'A bare string selects by value (shorthand for {value}); {label: "..."} selects by visible label; {index: N} selects by position; an array of any of those selects multiple options on a <select multiple>.',
        },
        index: {
          type: 'number',
          description:
            'Which <select> match to act on, when the selector matches more than one element.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Overall deadline covering the wait and the resolve. Default 8000.',
        },
        scroll: {
          type: 'boolean',
          description: 'Scroll the chosen match into view before measuring. Default true.',
        },
      },
      required: ['selector', 'option'],
    },
  },
  {
    name: 'bg_diagnostics_subscribe',
    description:
      "Turns on console, page-error, and network capture for one target. Call this before bg_read_console or bg_read_network: those tools only ever report what was collected after this call, never history from before it. Requires the devtools capability on the token. Network capture costs more than console/errors (it turns on the browser's own network instrumentation), so it defaults off; pass network true to include it.",
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        console: { type: 'boolean', description: 'Default true.' },
        errors: { type: 'boolean', description: 'Default true.' },
        network: { type: 'boolean', description: 'Default false: costs more, opt in.' },
      },
    },
  },
  {
    name: 'bg_read_console',
    description:
      'Console entries and uncaught page errors collected for one target since bg_diagnostics_subscribe was called on it. Returns nothing if that was never called. Keeps only the most recent 200 of each; older entries are dropped quietly, not the whole read. Use this to find a JS error or a console.log a screenshot cannot show.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_read_network',
    description:
      'Completed or failed network requests collected for one target since bg_diagnostics_subscribe was called on it with network true. Empty if network capture was never turned on, even if console capture was. Keeps only the most recent 200 rows. Use this to check a failed API call or a slow request; bg_read_console will not show either.',
    inputSchema: { type: 'object', properties: targetSelectorProperties() },
  },
  {
    name: 'bg_wait_for_network_idle',
    description:
      "Waits until a target's in-flight network request count drops to and stays at maxInflight for idleMs, then resolves. Requires the devtools capability on the token, and requires an active network diagnostics subscription with network capture on: call bg_diagnostics_subscribe with network true first, or this reports a clean POLICY_DENIED naming what is missing. Does not require a held control lease.",
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        maxInflight: {
          type: 'number',
          description:
            'Requests still allowed outstanding and the target still counted as idle. Default 0.',
        },
        idleMs: {
          type: 'number',
          description:
            'How long the in-flight count must stay at or below maxInflight, continuously, before this resolves. Default 500.',
        },
        timeoutMs: {
          type: 'number',
          description:
            "Overall deadline; reports TIMEOUT past this regardless of activity. Default the client's own default timeout.",
        },
      },
    },
  },
  {
    name: 'bg_page_map',
    description:
      'Captures a flat, indexed inventory of every element on the page the interactivity cascade judged actionable: tag, role and accessible name computed by CHROME ITSELF, a rect, a TRISTATE occlusion answer, and a small fixed attribute subset (id, name, type, href, value, placeholder, title, alt, aria-label, role, checked, disabled, readonly, required, tabindex). This is what bg_resolve alone cannot give: a whole-page survey in one round trip, before a selector is known. Occlusion is never collapsed to a guess: a rendered line carries |occluded| when something painted over the element, |occlusion?| when the answer could not be computed at all (offscreen, or the occlusion pass hit its own cap), and no marker when the element is genuinely clear; |occlusion?| must never be read as clear. A node whose frame lost its accessibility read renders role=? "?" rather than a guessed role or name, and the header states how many frames failed. Truncation, when it happens, is reported by REASON: offscreen (scroll and re-capture may help), onscreen (the byte budget went on visible content already in view, scrolling will not help), unpositioned (judged actionable but given no layout, so there is nowhere to click and re-capturing will not change that). THE INDEX IS HOW YOU ACT: each element carries an index (Chrome\'s own backendNodeId). Call this tool again with action "stamp", the SAME epoch this capture returned, and the chosen index or indices, to write a one-off marker attribute onto them; then address that element with bg_resolve or bg_click as selector "css=[<marker>]" (the marker name comes back from the stamp call). The epoch changes on every navigation, and a stamp against a stale epoch is refused before any write is attempted, which catches staleness BEFORE acting rather than after, unlike a bg_resolve ref= token, whose staleness is only ever discovered on use. The optional click-listener signal (default on, "listeners" false to skip) runs no page script and it is what indexes an element whose only actionability signal is a JavaScript handler; its real limit, stated plainly: DOMDebugger.getEventListeners reports a listener on the element it is attached TO, and a framework that delegates events to one ancestor (React 17 and later attach a single delegated listener at the root container, not one per element) means a delegated child is indexed only if it carries some OTHER signal (role, tabindex, pointer cursor). This signal alone never proves an element is unclickable. Requires the devtools capability, not evaluate: every command behind this call is a CDP domain read, no page script runs either way.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSelectorProperties(),
        action: {
          type: 'string',
          enum: ['capture', 'stamp'],
          description:
            'Default "capture": read the indexed page map. "stamp" writes the marker attribute onto specific indices from an earlier capture (epoch and indices both required in that case) so a later bg_resolve/bg_click can address them.',
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['nodes', 'text'] },
          description:
            'capture only. What to capture. Default ["nodes"]. Add "text" to also get headings/paragraphs/list items/links in the same round trip, sharing the one DOM tree walk rather than paying for it twice across two calls.',
        },
        listeners: {
          type: 'boolean',
          description:
            'capture only. Default true. See the click-listener paragraph above for what this does and does not prove.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'capture only. Capture deadline, milliseconds. Default 15000, clamped server side at 60000.',
        },
        epoch: {
          type: 'string',
          description:
            'stamp only, required: the epoch an earlier bg_page_map capture returned. A mismatch is refused before any write.',
        },
        indices: {
          type: 'array',
          items: { type: 'number' },
          description:
            'stamp only, required: the index values (the index field on a captured node) to stamp.',
        },
      },
    },
  },
  {
    name: 'bg_swarm_open',
    description:
      "Opens `size` browsers at once and returns a swarmId to address them together (bg_swarm_run) or one at a time (any other tool's swarmId/member arguments). Each member becomes a real running browser that stays open until bg_swarm_close is called or this MCP server shuts down, so prefer the smallest size the task actually needs. Fails cleanly, naming what is missing, if this server was not configured with a way to open browsers.",
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'number', description: 'How many browsers to open.' },
        url: {
          type: 'string',
          description:
            'If given, every member navigates here before this tool returns. Omit to leave members on whatever page they start on.',
        },
        isolation: {
          type: 'string',
          enum: ['tab', 'window'],
          description:
            "Informational only, passed through to this server's own acquire function; see PARALLELISM.md for what it means.",
        },
        subject: {
          type: 'string',
          description:
            'Who these browsers belong to. Omit (the default) and every member launches a brand new browser. Give a stable owner name ("nightly-crawler", "tenant-42") and each member slot reattaches to the browser that slot had last time, launching only if there is none, so re-running a task does not add another `size` browsers to the machine. Use the same subject from a second agent or process to work on the same set; use different subjects to stay isolated.',
        },
        stickyWithinMs: {
          type: 'number',
          description:
            "Only with subject: how stale a slot's previous browser may be, in milliseconds, and still be reattached to. Omit for no window (any still-live browser for that slot qualifies).",
        },
      },
      required: ['size'],
    },
  },
  {
    name: 'bg_swarm_list',
    description:
      "Lists open swarms, or one swarm's members. Cheap and local: reads this server's own swarm registry, no browser round trip. Call this before bg_swarm_run or a per-member tool if the swarmId or member index is not already known.",
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: {
          type: 'string',
          description:
            "If given, lists this swarm's members (index, instanceId, targetId). Omit to list every open swarm and its size instead.",
        },
      },
    },
  },
  {
    name: 'bg_swarm_grow',
    description:
      "Opens n more browsers and appends them to an existing swarm, concurrently, the same way bg_swarm_open does. New members get the next free slot numbers; existing members are left untouched. Inherits the swarm's own subject, so a swarm opened with one keeps reattaching to the browsers each slot already owns rather than launching new ones; there is nothing extra to pass here.",
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string' },
        n: { type: 'number', description: 'How many more members to open.' },
      },
      required: ['swarmId', 'n'],
    },
  },
  {
    name: 'bg_swarm_shrink',
    description:
      'Closes the n most recently added members of a swarm and drops them from it. Fails rather than clamping if n is larger than the swarm currently holds.',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string' },
        n: { type: 'number', description: 'How many of the newest members to close.' },
      },
      required: ['swarmId', 'n'],
    },
  },
  {
    name: 'bg_swarm_close',
    description:
      "Closes every connection a swarm holds and forgets it. Does not release anything this server's own acquire function reserved elsewhere, such as a pool slot or a profile lease: that is the deployment's own concern. Call this when done with a swarm. An agent that forgets to leaks running browsers only until this MCP server itself shuts down, at which point every outstanding swarm is closed automatically.",
    inputSchema: {
      type: 'object',
      properties: { swarmId: { type: 'string' } },
      required: ['swarmId'],
    },
  },
  {
    name: 'bg_swarm_run',
    description:
      "Runs one action on every member of a swarm at once, concurrently, not in a loop: every member starts before any of them finishes. One member failing, whether a thrown error, a lost lease, or a closed tab, is reported for that member alone and never stops or fails the others. This is the tool to reach for when driving more than one browser at once; the single-target tools with swarmId/member arguments are for acting on exactly one member instead. The navigate/click/type actions each acquire that member's control lease, run the action, and release it again, so no member is left holding control it never asked to keep.",
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['navigate', 'click', 'type', 'screenshot', 'status'],
          description: 'Which action every member runs.',
        },
        url: { type: 'string', description: 'navigate only.' },
        x: { type: 'number', description: 'click only, required alongside y.' },
        y: { type: 'number', description: 'click only, required alongside x.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'click only, default left.',
        },
        clickCount: { type: 'number', description: 'click only, default 1.' },
        text: { type: 'string', description: 'type only.' },
      },
      required: ['swarmId', 'action'],
    },
  },
]);

/** Options for {@link createAutomationMcpServer}. */
export interface AutomationMcpServerOptions {
  /** A connected `AutomationClient` this MCP server drives. The server does not own its lifecycle: call `client.close()` after closing the server. */
  client: AutomationClient;
  /** Reported to the MCP client. Default `'@browserglass/automation'`. */
  name?: string;
  /** Reported to the MCP client. Default `'0.0.0'`. */
  version?: string;
  /**
   * Enables `bg_swarm_open`/`bg_swarm_grow` by giving them a way to mint
   * new browsers. Omit this to run the server single-target only: the
   * swarm tools stay registered (so a caller can see them in `tools/list`
   * and read what they need) but every call reports `NOT_IMPLEMENTED`
   * naming exactly what is missing, rather than failing in some less
   * legible way further down.
   */
  swarm?: {
    /**
     * Same contract as `BrowserSwarmOptions.acquire`: called once per
     * member, concurrently. Mint a fresh requestId per call (from the
     * given index, or omit one entirely) or every member ends up pointed
     * at the same instance; see `PARALLELISM.md`'s "distinct requestIds"
     * gotcha.
     *
     * `ctx.subject` carries whatever `bg_swarm_open` was given for that
     * member slot. An implementation that ignores it still works, and the
     * `subject` tool argument then does nothing, which is the one way this
     * plumbing can quietly under-deliver: put `ctx.subject` on both
     * `AcquireRequest.subject` and `AcquireRequest.sticky.subject` when it
     * is set. See {@link SwarmAcquireContext}.
     */
    acquire(index: number, ctx: SwarmAcquireContext): Promise<SwarmAcquireResult>;
    /** Passed through to every member's `AutomationClient.connect()`; the same test-double injection point `BrowserSwarmOptions.transport` exposes. */
    transport?: { WebSocketImpl?: WebSocketConstructorLike };
  };
}

/**
 * Everything one `createAutomationMcpServer()` call needs to keep across
 * tool calls: the bound client, the swarm-opening function (if any), the
 * swarms this server has itself opened, and the diagnostics buffers/listener
 * bookkeeping `bg_diagnostics_subscribe` and the `bg_read_*` tools share.
 * Threaded through every `call*` function below instead of a module-level
 * global, so two `createAutomationMcpServer()` calls in the same process
 * (unusual, but nothing here forbids it) do not share state.
 */
interface McpServerState {
  readonly client: AutomationClient;
  readonly swarmAcquire:
    | ((index: number, ctx: SwarmAcquireContext) => Promise<SwarmAcquireResult>)
    | undefined;
  readonly swarmTransport: { WebSocketImpl?: WebSocketConstructorLike } | undefined;
  readonly swarms: Map<string, BrowserSwarm>;
  nextSwarmId: number;
  /** Owner keys (`'bound'` or `'<swarmId>:<memberIndex>'`) that already have `client.on('console'|'pageerror'|'network', ...)` listeners attached, so `bg_diagnostics_subscribe` called twice on the same connection does not double up delivery into the buffers below. */
  readonly diagListenersAttached: Set<string>;
  /** Keyed by `'<ownerKey>:<targetId>'`. */
  readonly diagBuffers: Map<string, DiagBuffers>;
}

interface DiagBuffers {
  console: AutomationEvents['console'][];
  errors: AutomationEvents['pageerror'][];
  network: AutomationEvents['network'][];
}

/** How many entries `bg_read_console`/`bg_read_network` keep per feed per target. A long-running debug session must not grow this without bound; the oldest entries are dropped first, matching a real devtools console's own scrollback behaviour. */
const MAX_DIAG_ENTRIES = 200;

function createMcpState(options: AutomationMcpServerOptions): McpServerState {
  return {
    client: options.client,
    swarmAcquire: options.swarm?.acquire,
    swarmTransport: options.swarm?.transport,
    swarms: new Map(),
    nextSwarmId: 1,
    diagListenersAttached: new Set(),
    diagBuffers: new Map(),
  };
}

function targetIdArg(client: AutomationClient, args: Record<string, unknown>): AutomationClient {
  const targetId = args['targetId'];
  return typeof targetId === 'string' && targetId.length > 0 ? client.forTarget(targetId) : client;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`'${key}' must be a string`);
  return v;
}

function getSwarm(state: McpServerState, swarmId: string): BrowserSwarm {
  const swarm = state.swarms.get(swarmId);
  if (!swarm)
    throw new AutomationError(
      'NOT_FOUND',
      `no open swarm '${swarmId}'; call bg_swarm_list to see what is open`,
    );
  return swarm;
}

function findMember(swarm: BrowserSwarm, memberArg: unknown): SwarmMember | undefined {
  if (typeof memberArg === 'number') return swarm.members[memberArg];
  if (typeof memberArg === 'string') return swarm.members.find((m) => m.instanceId === memberArg);
  return undefined;
}

/**
 * Resolves the `targetId`/`swarmId`/`member` trio every single-target tool
 * accepts into one client to call and one stable key to buffer diagnostics
 * under. `swarmId` present routes into that swarm's `member` (a required
 * companion argument in that case); otherwise this falls back to the
 * server's own bound client and `targetId`, exactly the original five
 * tools' own behaviour before swarms existed.
 */
function resolveTarget(
  state: McpServerState,
  args: Record<string, unknown>,
): { client: AutomationClient; ownerKey: string } {
  const swarmId = args['swarmId'];
  if (typeof swarmId === 'string' && swarmId.length > 0) {
    const swarm = getSwarm(state, swarmId);
    const member = findMember(swarm, args['member']);
    if (!member)
      throw new AutomationError(
        'NOT_FOUND',
        `swarm '${swarmId}' has no member matching '${String(args['member'])}'; call bg_swarm_list to see valid indexes`,
      );
    return { client: targetIdArg(member.client, args), ownerKey: `${swarmId}:${member.index}` };
  }
  return { client: targetIdArg(state.client, args), ownerKey: 'bound' };
}

/**
 * The stand-down block every control-relevant tool result carries, or `{}`
 * when nobody has taken this browser over.
 *
 * An agent driving through MCP has no callbacks. It sees tool results and
 * nothing else, so `AutomationClient.onControlYield()` is invisible to it,
 * and a yield that exists only as a callback is a yield the most likely
 * user of this package cannot observe at all. This is the same
 * information, pushed into the one channel an MCP client actually reads.
 *
 * `humanTookOver` is spelled out rather than left as a `reason` string to
 * be pattern matched, because the model reading this has to get one
 * decision right and only one: a person is driving, so stop.
 */
function controlYieldTrailer(client: AutomationClient): Record<string, unknown> {
  const ev = client.yieldStatus();
  if (ev === null) return {};
  return {
    controlYield: {
      targetId: ev.targetId,
      phase: ev.phase,
      reason: ev.reason,
      byLabel: ev.byLabel,
      humanTookOver: ev.human,
      resumeNotBefore: ev.resumeNotBefore,
      interrupted: ev.inFlight.map((a) => a.action),
      advice: ev.human
        ? 'A person is driving this browser. Do not act on it and do not acquire control. Report back to the user instead.'
        : 'Another driver has this browser. Do not retry blindly; call bg_control action "yield_status" before requesting control again.',
    },
  };
}

function bufferFor(state: McpServerState, bufferKey: string): DiagBuffers {
  let buf = state.diagBuffers.get(bufferKey);
  if (!buf) {
    buf = { console: [], errors: [], network: [] };
    state.diagBuffers.set(bufferKey, buf);
  }
  return buf;
}

function pushCapped<T>(arr: T[], entry: T): void {
  arr.push(entry);
  if (arr.length > MAX_DIAG_ENTRIES) arr.shift();
}

/**
 * Attaches this server's own buffering listeners to `client`'s connection,
 * once per `ownerKey`: `AutomationClient.on()` is global to the socket, not
 * scoped to whichever sub-client called it (its own doc comment says so),
 * so attaching again on a second `bg_diagnostics_subscribe` call for the
 * same connection would deliver every future event twice. The listener
 * itself routes by `ev.targetId` into a buffer keyed by that target, not
 * just `ownerKey`, since one connection can have diagnostics on for more
 * than one of its own targets.
 */
function attachDiagListeners(
  state: McpServerState,
  ownerKey: string,
  client: AutomationClient,
): void {
  if (state.diagListenersAttached.has(ownerKey)) return;
  state.diagListenersAttached.add(ownerKey);
  client.on('console', (ev) =>
    pushCapped(bufferFor(state, `${ownerKey}:${ev.targetId}`).console, ev),
  );
  client.on('pageerror', (ev) =>
    pushCapped(bufferFor(state, `${ownerKey}:${ev.targetId}`).errors, ev),
  );
  client.on('network', (ev) =>
    pushCapped(bufferFor(state, `${ownerKey}:${ev.targetId}`).network, ev),
  );
}

// ==================================================================
// The original five single-target tools, plus bg_navigate/bg_screenshot.
// All now resolve through resolveTarget() so a swarmId/member argument
// routes into one swarm member instead of the bound client.
// ==================================================================

/** `bg_status`. */
async function callStatus(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const status = await client.status();
    const heading = status.title || status.url || '(no page loaded)';
    const loadState = status.loading ? 'still loading' : 'loaded';
    const control = status.leaseHolderLabel
      ? `controlled by ${status.leaseHolderLabel}`
      : 'no one holds control';
    const yielded = client.yieldStatus();
    // Said in the plain-text summary, not only in the JSON trailer. This
    // is the cheapest tool in the manifest and the one an agent calls to
    // orient itself, so it is where "you have been taken over" has to be
    // impossible to miss.
    const standDown =
      yielded === null
        ? ''
        : yielded.human
          ? ` A person (${yielded.byLabel || 'unnamed viewer'}) has taken this browser over; this agent has stood down.`
          : ` Control was yielded to ${yielded.byLabel || 'another driver'}; this agent has stood down.`;
    const summary = `${heading}, ${loadState}, ${control}.${standDown}`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_status',
      durationMs: Date.now() - startedAt,
      status,
      ...controlYieldTrailer(client),
    });
  } catch (err) {
    return formatToolError('bg_status', startedAt, err);
  }
}

/** `bg_read_page`. `text()` is built on `page.evaluate`, so this refuses on the `evaluate` capability rather than on a stub when the token does not carry it. */
async function callReadPage(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const text = await client.text();
    return formatToolResult(text.slice(0, 2000), {
      ok: true,
      action: 'bg_read_page',
      durationMs: Date.now() - startedAt,
      length: text.length,
    });
  } catch (err) {
    return formatToolError('bg_read_page', startedAt, err);
  }
}

/** `bg_click`. */
async function callClick(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const x = args['x'];
    const y = args['y'];
    const selector = args['selector'];
    const button = args['button'];
    const clickCount = args['clickCount'];
    const modifiersArg = args['modifiers'];
    const modifiers = Array.isArray(modifiersArg)
      ? (modifiersArg as Array<'Alt' | 'Control' | 'Meta' | 'Shift'>)
      : undefined;
    if (typeof x === 'number' && typeof y === 'number') {
      await client.clickAt(x, y, {
        ...(typeof button === 'string' ? { button: button as 'left' | 'right' | 'middle' } : {}),
        ...(typeof clickCount === 'number' ? { clickCount } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      });
      return formatToolResult(`Clicked at (${x}, ${y}).`, {
        ok: true,
        action: 'bg_click',
        durationMs: Date.now() - startedAt,
        x,
        y,
      });
    }
    if (typeof selector === 'string') {
      const result = await client.click(selector, {
        ...(typeof button === 'string' ? { button: button as 'left' | 'right' | 'middle' } : {}),
        ...(typeof clickCount === 'number' ? { clickCount } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      });
      return formatToolResult(`Clicked '${selector}'.`, {
        ...result,
        ok: true,
        action: 'bg_click',
        durationMs: Date.now() - startedAt,
        selector,
      });
    }
    throw new Error('bg_click needs either x and y, or a selector');
  } catch (err) {
    return formatToolError('bg_click', startedAt, err);
  }
}

/**
 * `bg_set_input_files`.
 *
 * `paths` reads files from the machine this MCP server runs on, which is
 * the agent's own machine and the agent's own process. That is a very
 * different thing from letting a REMOTE caller name a path on the gateway,
 * which nothing in this system permits: reading your own disk with your own
 * privileges is not an escalation, and it is the only way an agent with a
 * document on hand can attach it. The bytes are then streamed over the
 * socket, and the browser is handed a path the GATEWAY composed. See
 * `@browserglass/server`'s `files/safe-name.ts` for that side of the line.
 */
async function callSetInputFiles(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const files: UploadFileInput[] = [];

    const paths = args['paths'];
    if (Array.isArray(paths)) {
      const { readFile } = await import('node:fs/promises');
      const { basename } = await import('node:path');
      for (const p of paths) {
        if (typeof p !== 'string')
          throw new Error('bg_set_input_files: every entry in paths must be a string');
        files.push({ name: basename(p), data: new Uint8Array(await readFile(p)) });
      }
    }

    const inline = args['files'];
    if (Array.isArray(inline)) {
      for (const entry of inline) {
        if (entry === null || typeof entry !== 'object')
          throw new Error('bg_set_input_files: every entry in files must be an object');
        const rec = entry as Record<string, unknown>;
        const name = rec['name'];
        const dataBase64 = rec['dataBase64'];
        if (typeof name !== 'string' || typeof dataBase64 !== 'string') {
          throw new Error('bg_set_input_files: every entry in files needs a name and dataBase64');
        }
        const mime = rec['mime'];
        files.push({
          name,
          data: base64ToBytes(dataBase64),
          ...(typeof mime === 'string' ? { mime } : {}),
        });
      }
    }

    if (files.length === 0) throw new Error('bg_set_input_files needs paths or files');
    const attached = await client.setInputFiles(selector, files);
    return formatToolResult(
      `Attached ${attached.length} file(s) to '${selector}': ${attached.join(', ')}.`,
      {
        ok: true,
        action: 'bg_set_input_files',
        durationMs: Date.now() - startedAt,
        selector,
        files: attached,
      },
    );
  } catch (err) {
    return formatToolError('bg_set_input_files', startedAt, err);
  }
}

/** Decodes base64 to bytes without assuming `Buffer`, matching the rest of this package. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** `bg_type`. */
async function callType(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const text = requireString(args, 'text');
    const humanLike = args['humanLike'] === true;
    if (humanLike) await client.humanType(text);
    else await client.type(text);
    return formatToolResult(`Typed ${text.length} characters.`, {
      ok: true,
      action: 'bg_type',
      durationMs: Date.now() - startedAt,
      length: text.length,
      humanLike,
    });
  } catch (err) {
    return formatToolError('bg_type', startedAt, err);
  }
}

/** `bg_control`. */
async function callControl(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const action = requireString(args, 'action');
    const reason = args['reason'];
    const waitMs = args['waitMs'];
    const durationMsArg = args['durationMs'];

    if (action === 'acquire') {
      const lease = await client.acquireControl({
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(typeof waitMs === 'number' ? { waitMs } : {}),
        ...(typeof durationMsArg === 'number' ? { durationMs: durationMsArg } : {}),
      });
      return formatToolResult(
        `Control acquired, expires in ${Math.round((lease.expiresAt - Date.now()) / 1000)}s.`,
        {
          ok: true,
          action: 'bg_control',
          durationMs: Date.now() - startedAt,
          leaseId: lease.leaseId,
          expiresAt: lease.expiresAt,
        },
      );
    }
    if (action === 'release') {
      await client.releaseControl();
      return formatToolResult('Control released.', {
        ok: true,
        action: 'bg_control',
        durationMs: Date.now() - startedAt,
      });
    }
    if (action === 'status') {
      const status = await client.status();
      const summary = status.leaseHolderLabel
        ? `Controlled by ${status.leaseHolderLabel}.`
        : 'No one holds control.';
      return formatToolResult(summary, {
        ok: true,
        action: 'bg_control',
        durationMs: Date.now() - startedAt,
        leaseHolderViewerId: status.leaseHolderViewerId,
        leaseHolderLabel: status.leaseHolderLabel,
        ...controlYieldTrailer(client),
      });
    }
    if (action === 'yield') {
      await client.yieldControl(typeof reason === 'string' ? reason : undefined);
      return formatToolResult(
        'Stood down: control released and this agent will not send input to this browser until it acquires control again.',
        {
          ok: true,
          action: 'bg_control',
          durationMs: Date.now() - startedAt,
          ...controlYieldTrailer(client),
        },
      );
    }
    if (action === 'yield_status') {
      const ev = client.yieldStatus();
      const summary =
        ev === null
          ? 'No one has taken this browser over; this agent is free to drive it.'
          : ev.human
            ? `${ev.byLabel || 'A person'} took this browser over. Stop driving it and report back to the user.`
            : `Control was yielded to ${ev.byLabel || 'another driver'} (${ev.reason}).`;
      return formatToolResult(summary, {
        ok: true,
        action: 'bg_control',
        durationMs: Date.now() - startedAt,
        yielded: ev !== null,
        ...controlYieldTrailer(client),
      });
    }
    throw new Error(
      `bg_control: unknown action '${action}'; expected acquire, release, status, yield, or yield_status`,
    );
  } catch (err) {
    return formatToolError('bg_control', startedAt, err);
  }
}

/** `bg_navigate`. */
async function callNavigate(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const url = requireString(args, 'url');
    const status = await client.navigate(url);
    return formatToolResult(`Navigated to ${status.url}.`, {
      ok: true,
      action: 'bg_navigate',
      durationMs: Date.now() - startedAt,
      status,
    });
  } catch (err) {
    return formatToolError('bg_navigate', startedAt, err);
  }
}

/** `bg_screenshot`. */
async function callScreenshot(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const format = args['format'];
    const fullPage = args['fullPage'];
    const maxDimension = args['maxDimension'];
    const result = await client.screenshot({
      ...(typeof format === 'string' ? { format: format as 'png' | 'jpeg' } : {}),
      ...(typeof fullPage === 'boolean' ? { fullPage } : {}),
      ...(typeof maxDimension === 'number' ? { maxDimension } : {}),
    });
    return formatToolResult(
      `Captured ${result.width}x${result.height} ${result.format}, ${result.sizeBytes} bytes.`,
      {
        ok: true,
        action: 'bg_screenshot',
        durationMs: Date.now() - startedAt,
        captureId: result.captureId,
        targetId: result.targetId,
        format: result.format,
        width: result.width,
        height: result.height,
        sizeBytes: result.sizeBytes,
        data: result.data,
      },
    );
  } catch (err) {
    return formatToolError('bg_screenshot', startedAt, err);
  }
}

/** `bg_pdf`. */
async function callPdf(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const format = args['format'];
    const widthInches = args['widthInches'];
    const heightInches = args['heightInches'];
    const landscape = args['landscape'];
    const printBackground = args['printBackground'];
    const scale = args['scale'];
    const marginTopInches = args['marginTopInches'];
    const marginBottomInches = args['marginBottomInches'];
    const marginLeftInches = args['marginLeftInches'];
    const marginRightInches = args['marginRightInches'];
    const pageRanges = args['pageRanges'];
    const headerTemplate = args['headerTemplate'];
    const footerTemplate = args['footerTemplate'];
    const result = await client.pdf({
      ...(typeof format === 'string' ? { format: format as PdfPaperFormat } : {}),
      ...(typeof widthInches === 'number' ? { widthInches } : {}),
      ...(typeof heightInches === 'number' ? { heightInches } : {}),
      ...(typeof landscape === 'boolean' ? { landscape } : {}),
      ...(typeof printBackground === 'boolean' ? { printBackground } : {}),
      ...(typeof scale === 'number' ? { scale } : {}),
      ...(typeof marginTopInches === 'number' ? { marginTopInches } : {}),
      ...(typeof marginBottomInches === 'number' ? { marginBottomInches } : {}),
      ...(typeof marginLeftInches === 'number' ? { marginLeftInches } : {}),
      ...(typeof marginRightInches === 'number' ? { marginRightInches } : {}),
      ...(typeof pageRanges === 'string' ? { pageRanges } : {}),
      ...(typeof headerTemplate === 'string' ? { headerTemplate } : {}),
      ...(typeof footerTemplate === 'string' ? { footerTemplate } : {}),
    });
    const summary =
      result.data !== undefined
        ? `Rendered a ${result.sizeBytes} byte PDF, returned inline.`
        : `Rendered a ${result.sizeBytes} byte PDF, too large to inline; fetch it from "url" before it expires.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_pdf',
      durationMs: Date.now() - startedAt,
      pdfId: result.pdfId,
      targetId: result.targetId,
      sizeBytes: result.sizeBytes,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.downloadId !== undefined ? { downloadId: result.downloadId } : {}),
      ...(result.url !== undefined ? { url: result.url } : {}),
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      ...(result.sha256 !== undefined ? { sha256: result.sha256 } : {}),
    });
  } catch (err) {
    return formatToolError('bg_pdf', startedAt, err);
  }
}

/** `bg_recording`. */
async function callRecording(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const action = requireString(args, 'action');

    if (action === 'start') {
      const mode = args['mode'];
      const handle = await client.startRecording({
        ...(typeof mode === 'string' ? { mode: mode as 'live' | 'thumbnail' } : {}),
      });
      return formatToolResult(
        `Recording ${handle.recordingId} started on ${handle.targetId}. This is written to the gateway's own disk and outlives this session; read it back with "bgls record list"/"bgls record export" against the gateway's --recordings-dir, not through this tool. Stop it with bg_recording action "stop".`,
        {
          ok: true,
          action: 'bg_recording',
          durationMs: Date.now() - startedAt,
          recordingId: handle.recordingId,
          targetId: handle.targetId,
          mode: handle.mode,
          startedAtMs: handle.startedAtMs,
        },
      );
    }
    if (action === 'stop') {
      const recordingId = requireString(args, 'recordingId');
      const result = await client.stopRecording(recordingId);
      const summary = result.failed
        ? `Recording ${result.recordingId} stopped, but it had already degraded to a no-op after a write failure; ${result.framesWritten} frame(s) reached disk before that happened.`
        : `Recording ${result.recordingId} stopped: ${result.framesWritten} frame(s) written. Read it back with "bgls record list"/"bgls record export".`;
      return formatToolResult(summary, {
        ok: true,
        action: 'bg_recording',
        durationMs: Date.now() - startedAt,
        recordingId: result.recordingId,
        targetId: result.targetId,
        startedAtMs: result.startedAtMs,
        stoppedAtMs: result.stoppedAtMs,
        framesWritten: result.framesWritten,
        failed: result.failed,
      });
    }
    if (action === 'list') {
      const recordings = await client.listRecordings();
      const summary =
        recordings.length === 0
          ? 'No recordings on this session.'
          : `${recordings.length} recording(s) this session's socket knows about. This is a live in-memory view, not the same as what "bgls record list" sees on disk after the fact.`;
      return formatToolResult(summary, {
        ok: true,
        action: 'bg_recording',
        durationMs: Date.now() - startedAt,
        recordings,
      });
    }
    throw new Error(`bg_recording: unknown action '${action}'; expected start, stop, or list`);
  } catch (err) {
    return formatToolError('bg_recording', startedAt, err);
  }
}

/** `bg_back`. */
async function callBack(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const status = await client.goBack();
    return formatToolResult(`Went back to ${status.url}.`, {
      ok: true,
      action: 'bg_back',
      durationMs: Date.now() - startedAt,
      status,
    });
  } catch (err) {
    return formatToolError('bg_back', startedAt, err);
  }
}

/** `bg_forward`. */
async function callForward(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const status = await client.goForward();
    return formatToolResult(`Went forward to ${status.url}.`, {
      ok: true,
      action: 'bg_forward',
      durationMs: Date.now() - startedAt,
      status,
    });
  } catch (err) {
    return formatToolError('bg_forward', startedAt, err);
  }
}

/** `bg_reload`. */
async function callReload(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const ignoreCache = args['ignoreCache'];
    const status = await client.reload({
      ...(typeof ignoreCache === 'boolean' ? { ignoreCache } : {}),
    });
    return formatToolResult(`Reloaded ${status.url}.`, {
      ok: true,
      action: 'bg_reload',
      durationMs: Date.now() - startedAt,
      status,
    });
  } catch (err) {
    return formatToolError('bg_reload', startedAt, err);
  }
}

/** `bg_stop`. */
async function callStop(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    await client.stop();
    return formatToolResult('Stopped loading.', {
      ok: true,
      action: 'bg_stop',
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    return formatToolError('bg_stop', startedAt, err);
  }
}

/** `bg_press_key`. */
async function callPressKey(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const key = requireString(args, 'key');
    const modifiersArg = args['modifiers'];
    const modifiers = Array.isArray(modifiersArg)
      ? (modifiersArg as Array<'Alt' | 'Control' | 'Meta' | 'Shift'>)
      : undefined;
    await client.pressKey(key, { ...(modifiers !== undefined ? { modifiers } : {}) });
    return formatToolResult(`Pressed '${key}'.`, {
      ok: true,
      action: 'bg_press_key',
      durationMs: Date.now() - startedAt,
      key,
    });
  } catch (err) {
    return formatToolError('bg_press_key', startedAt, err);
  }
}

/** `bg_scroll`. */
async function callScroll(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const x = args['x'];
    const y = args['y'];
    const dx = args['dx'];
    const dy = args['dy'];
    await client.scroll({
      ...(typeof x === 'number' ? { x } : {}),
      ...(typeof y === 'number' ? { y } : {}),
      ...(typeof dx === 'number' ? { dx } : {}),
      ...(typeof dy === 'number' ? { dy } : {}),
    });
    return formatToolResult('Scrolled.', {
      ok: true,
      action: 'bg_scroll',
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    return formatToolError('bg_scroll', startedAt, err);
  }
}

/** `bg_wait_for_navigation`. */
async function callWaitForNavigation(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const timeoutMs = args['timeoutMs'];
    const status = await client.waitForNavigation({
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    return formatToolResult(`Navigation settled at ${status.url}.`, {
      ok: true,
      action: 'bg_wait_for_navigation',
      durationMs: Date.now() - startedAt,
      status,
    });
  } catch (err) {
    return formatToolError('bg_wait_for_navigation', startedAt, err);
  }
}

/** `bg_tabs`. "activate" and "close" act on the tab named by the `tabId` argument, distinct from the `targetId`/`swarmId`/`member` trio `resolveTarget()` uses to pick which connection this call itself runs over. */
async function callTabs(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const action = requireString(args, 'action');
    if (action === 'list') {
      const tabs = await client.tabs.list();
      return formatToolResult(`${tabs.length} tab(s).`, {
        ok: true,
        action: 'bg_tabs',
        durationMs: Date.now() - startedAt,
        tabs,
      });
    }
    if (action === 'open') {
      const url = args['url'];
      const background = args['background'];
      const tab = await client.tabs.open({
        ...(typeof url === 'string' ? { url } : {}),
        ...(typeof background === 'boolean' ? { background } : {}),
      });
      return formatToolResult(`Opened tab ${tab.targetId} at ${tab.url}.`, {
        ok: true,
        action: 'bg_tabs',
        durationMs: Date.now() - startedAt,
        tab,
      });
    }
    if (action === 'activate') {
      const tabId = requireString(args, 'tabId');
      await client.tabs.activate(tabId);
      return formatToolResult(`Activated tab ${tabId}.`, {
        ok: true,
        action: 'bg_tabs',
        durationMs: Date.now() - startedAt,
        tabId,
      });
    }
    if (action === 'close') {
      const tabId = requireString(args, 'tabId');
      await client.tabs.close(tabId);
      return formatToolResult(`Closed tab ${tabId}.`, {
        ok: true,
        action: 'bg_tabs',
        durationMs: Date.now() - startedAt,
        tabId,
      });
    }
    throw new Error(`bg_tabs: unknown action '${action}'; expected list, open, activate, or close`);
  } catch (err) {
    return formatToolError('bg_tabs', startedAt, err);
  }
}

// ==================================================================
// The locator surface: bg_evaluate, bg_resolve, bg_wait_for,
// bg_wait_for_text, bg_get_text, bg_fill, bg_select. Thin wrappers over
// the AutomationClient methods of the same (unprefixed) name; see
// ../client/AutomationClient.ts and ../locator/types.ts for what each one
// actually does and returns. All resolve through resolveTarget() like
// every tool above, so swarmId/member keeps working here too.
//
// Every reply here is trimmed before it crosses the wire back to the
// agent. resolve()/waitForSelector() return the full LocatorMatch (rect,
// the five actionability booleans, opacity, pointerEvents,
// disabledReason, hitReason, id/name/role, readValue...) because
// AutomationClient has no idea which of those fields any one caller
// needs. An MCP tool call is not free the way an in-process property read
// is: the agent on the other end of the transport pays real tokens for
// every field in the reply. summarizeMatch() below keeps exactly what an
// agent needs to decide its next move (identity, the rect, the five
// actionability booleans, and what is occluding the element) and drops
// the rest.
// ==================================================================

/** The subset of `LocatorMatch` (`../locator/types.js`) worth spending tokens on in an MCP reply. See the section doc above for why the full match is not returned as is. */
function summarizeMatch(m: LocatorMatch): Record<string, unknown> {
  return {
    index: m.index,
    ref: m.ref,
    tagName: m.tagName,
    describe: m.describe,
    rect: m.rect,
    center: m.center,
    attached: m.attached,
    visible: m.visible,
    enabled: m.enabled,
    stable: m.stable,
    hitTestOk: m.hitTestOk,
    occludedBy: m.occludedBy,
    text: m.text,
    value: m.value,
    checked: m.checked,
  };
}

/**
 * `bg_evaluate`. Wraps `client.evaluateWith()` rather than `client.evaluate()`
 * so `timeoutMs`/`awaitPromise`/`userGesture` are reachable from the tool
 * schema. `args` (the variadic substitution `evaluate()` offers a function
 * form) is not exposed here: an MCP caller can only ever supply an
 * `expression` string over the JSON wire, never a live function, and that
 * substitution only applies to the function form (see
 * `AutomationClient.evaluate`'s own doc).
 */
async function callEvaluate(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const expression = requireString(args, 'expression');
    const awaitPromise = args['awaitPromise'];
    const userGesture = args['userGesture'];
    const timeoutMs = args['timeoutMs'];
    const result = await client.evaluateWith(expression, [], {
      ...(typeof awaitPromise === 'boolean' ? { awaitPromise } : {}),
      ...(typeof userGesture === 'boolean' ? { userGesture } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    return formatToolResult(`Evaluated '${expression}'.`, {
      ok: true,
      action: 'bg_evaluate',
      durationMs: Date.now() - startedAt,
      expression,
      result,
    });
  } catch (err) {
    return formatToolError('bg_evaluate', startedAt, err);
  }
}

/** `bg_resolve`. See the section doc above for why the reply is `summarizeMatch()`'d rather than the raw `LocatorMatch[]` `client.resolve()` itself returns. */
async function callResolve(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const limit = args['limit'];
    const stamp = args['stamp'];
    const stable = args['stable'];
    const hitTest = args['hitTest'];
    const scroll = args['scroll'];
    const scrollIndex = args['scrollIndex'];
    const within = args['within'];
    const textLimit = args['textLimit'];
    const timeoutMs = args['timeoutMs'];
    const result = await client.resolve(selector, {
      ...(typeof limit === 'number' ? { limit } : {}),
      ...(typeof stamp === 'boolean' ? { stamp } : {}),
      ...(typeof stable === 'boolean' ? { stable } : {}),
      ...(typeof hitTest === 'boolean' ? { hitTest } : {}),
      ...(typeof scroll === 'boolean' ? { scroll } : {}),
      ...(typeof scrollIndex === 'number' ? { scrollIndex } : {}),
      ...(typeof within === 'string' ? { within } : {}),
      ...(typeof textLimit === 'number' ? { textLimit } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    const summary = `${result.total} match(es) for '${selector}'${result.truncated ? ' (truncated)' : ''}.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_resolve',
      durationMs: Date.now() - startedAt,
      selector,
      engine: result.engine,
      total: result.total,
      truncated: result.truncated,
      url: result.url,
      matches: result.matches.map(summarizeMatch),
    });
  } catch (err) {
    return formatToolError('bg_resolve', startedAt, err);
  }
}

/** `bg_wait_for`, wrapping `client.waitForSelector()` (Playwright's own spelling of `waitFor()`; see that method's doc for the MutationObserver-backed wait this holds in the page). */
async function callWaitFor(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const waitState = args['state'];
    const timeoutMs = args['timeoutMs'];
    const pollMs = args['pollMs'];
    const index = args['index'];
    const result = await client.waitForSelector(selector, {
      ...(typeof waitState === 'string'
        ? { state: waitState as 'attached' | 'detached' | 'visible' | 'hidden' | 'actionable' }
        : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof pollMs === 'number' ? { pollMs } : {}),
      ...(typeof index === 'number' ? { index } : {}),
    });
    const summary = `'${selector}' reached '${typeof waitState === 'string' ? waitState : 'visible'}': ${result.total} match(es), ${result.checks} check(s), ${result.wakes} DOM wake(s) in ${result.waitedMs}ms.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_wait_for',
      durationMs: Date.now() - startedAt,
      selector,
      total: result.total,
      waitedMs: result.waitedMs,
      checks: result.checks,
      wakes: result.wakes,
      matches: result.matches.map(summarizeMatch),
    });
  } catch (err) {
    return formatToolError('bg_wait_for', startedAt, err);
  }
}

/** `bg_wait_for_text`. */
async function callWaitForText(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const text = requireString(args, 'text');
    const timeoutMs = args['timeoutMs'];
    const pollingMs = args['pollingMs'];
    const exact = args['exact'];
    const matched = await client.waitForText(selector, text, {
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof pollingMs === 'number' ? { pollingMs } : {}),
      ...(typeof exact === 'boolean' ? { exact } : {}),
    });
    return formatToolResult(`'${selector}' matched text: ${matched}`, {
      ok: true,
      action: 'bg_wait_for_text',
      durationMs: Date.now() - startedAt,
      selector,
      text: matched,
    });
  } catch (err) {
    return formatToolError('bg_wait_for_text', startedAt, err);
  }
}

/** `bg_get_text`, wrapping `client.innerText()`. Truncated the same way `bg_read_page` truncates a full page's text and for the same reason: `length` says whether anything was cut. */
async function callGetText(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const index = args['index'];
    const timeoutMs = args['timeoutMs'];
    const limit = args['limit'];
    const text = await client.innerText(selector, {
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    return formatToolResult(text.slice(0, 2000), {
      ok: true,
      action: 'bg_get_text',
      durationMs: Date.now() - startedAt,
      selector,
      length: text.length,
    });
  } catch (err) {
    return formatToolError('bg_get_text', startedAt, err);
  }
}

/** `bg_get_attribute`, wrapping `client.getAttribute()`. */
async function callGetAttribute(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const name = requireString(args, 'name');
    const index = args['index'];
    const timeoutMs = args['timeoutMs'];
    const value = await client.getAttribute(selector, name, {
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    const summary =
      value === null
        ? `'${selector}' has no '${name}' attribute.`
        : `'${selector}'.${name} = '${value}'.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_get_attribute',
      durationMs: Date.now() - startedAt,
      selector,
      name,
      value,
    });
  } catch (err) {
    return formatToolError('bg_get_attribute', startedAt, err);
  }
}

/** `bg_is_checked`, wrapping `client.isChecked()`. */
async function callIsChecked(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const index = args['index'];
    const timeoutMs = args['timeoutMs'];
    const checked = await client.isChecked(selector, {
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    return formatToolResult(`'${selector}' is ${checked ? '' : 'not '}checked.`, {
      ok: true,
      action: 'bg_is_checked',
      durationMs: Date.now() - startedAt,
      selector,
      checked,
    });
  } catch (err) {
    return formatToolError('bg_is_checked', startedAt, err);
  }
}

/** `bg_get_html`, wrapping `client.html()`. Truncated the same way `bg_read_page` truncates a full page's text and for the same reason: `length` says whether anything was cut. */
async function callGetHtml(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const html = await client.html();
    return formatToolResult(html.slice(0, 2000), {
      ok: true,
      action: 'bg_get_html',
      durationMs: Date.now() - startedAt,
      length: html.length,
    });
  } catch (err) {
    return formatToolError('bg_get_html', startedAt, err);
  }
}

/** `bg_scroll_into_view`, wrapping `client.scrollIntoView()`. Reply is `summarizeMatch()`'d like `bg_resolve`'s, for the same reason (see the section doc above). */
async function callScrollIntoView(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const index = args['index'];
    const timeoutMs = args['timeoutMs'];
    const match = await client.scrollIntoView(selector, {
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    return formatToolResult(`Scrolled '${selector}' into view.`, {
      ok: true,
      action: 'bg_scroll_into_view',
      durationMs: Date.now() - startedAt,
      selector,
      match: summarizeMatch(match),
    });
  } catch (err) {
    return formatToolError('bg_scroll_into_view', startedAt, err);
  }
}

/** `bg_fill`. */
async function callFill(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const value = requireString(args, 'value');
    const index = args['index'];
    const timeoutMs = args['timeoutMs'];
    const mode = args['mode'];
    const delayMs = args['delayMs'];
    const clear = args['clear'];
    const click = args['click'];
    const verify = args['verify'];
    const strict = args['strict'];
    const scroll = args['scroll'];
    const result = await client.fill(selector, value, {
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof mode === 'string' ? { mode: mode as 'keys' | 'insert' } : {}),
      ...(typeof delayMs === 'number' ? { delayMs } : {}),
      ...(typeof clear === 'boolean' ? { clear } : {}),
      ...(typeof click === 'boolean' ? { click } : {}),
      ...(typeof verify === 'boolean' ? { verify } : {}),
      ...(typeof strict === 'boolean' ? { strict } : {}),
      ...(typeof scroll === 'boolean' ? { scroll } : {}),
    });
    const verifiedNote =
      result.verified === null
        ? ''
        : result.verified
          ? ' (verified)'
          : ` (read back '${result.actual}', which does not match)`;
    return formatToolResult(`Filled '${selector}'${verifiedNote}.`, {
      ...result,
      ok: true,
      action: 'bg_fill',
      durationMs: Date.now() - startedAt,
      selector,
    });
  } catch (err) {
    return formatToolError('bg_fill', startedAt, err);
  }
}

/**
 * Parses the JSON `option` argument `bg_select` accepts into
 * `SelectOptionSpec | SelectOptionSpec[]`: a bare string (by value),
 * `{value}`, `{label}`, `{index}`, or an array of those for a
 * `<select multiple>`. Mirrors `SelectOptionSpec` (`../locator/types.js`)
 * by hand rather than importing a JSON Schema validator for it, because the
 * wire only ever carries plain JSON and cannot carry that union's own
 * discrimination for free.
 */
function parseSelectOption(raw: unknown): SelectOptionSpec | SelectOptionSpec[] {
  if (Array.isArray(raw)) return raw.map(parseSelectOptionOne);
  return parseSelectOptionOne(raw);
}

function parseSelectOptionOne(raw: unknown): SelectOptionSpec {
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec['value'] === 'string') return { value: rec['value'] };
    if (typeof rec['label'] === 'string') return { label: rec['label'] };
    if (typeof rec['index'] === 'number') return { index: rec['index'] };
  }
  throw new Error(
    "bg_select: every 'option' entry must be a string, or {value}, {label}, or {index}",
  );
}

/** `bg_select`. */
async function callSelect(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const selector = requireString(args, 'selector');
    const rawOption = args['option'];
    if (rawOption === undefined) throw new Error("bg_select needs 'option'");
    const option = parseSelectOption(rawOption);
    const index = args['index'];
    const timeoutMs = args['timeoutMs'];
    const scroll = args['scroll'];
    const result = await client.select(selector, option, {
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof scroll === 'boolean' ? { scroll } : {}),
    });
    return formatToolResult(`Selected on '${selector}': ${result.values.join(', ')}.`, {
      ...result,
      ok: true,
      action: 'bg_select',
      durationMs: Date.now() - startedAt,
      selector,
    });
  } catch (err) {
    return formatToolError('bg_select', startedAt, err);
  }
}

// ==================================================================
// Diagnostics: subscribe, then read what has accumulated since.
// ==================================================================

/** `bg_diagnostics_subscribe`. */
async function callDiagnosticsSubscribe(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client, ownerKey } = resolveTarget(state, args);
    attachDiagListeners(state, ownerKey, client);
    const consoleArg = args['console'];
    const errorsArg = args['errors'];
    const networkArg = args['network'];
    const sub = await client.diagnostics.subscribe({
      ...(typeof consoleArg === 'boolean' ? { console: consoleArg } : {}),
      ...(typeof errorsArg === 'boolean' ? { errors: errorsArg } : {}),
      ...(typeof networkArg === 'boolean' ? { network: networkArg } : {}),
    });
    const summary = `Subscribed ${sub.targetId}: console ${sub.console}, errors ${sub.errors}, network ${sub.network}.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_diagnostics_subscribe',
      durationMs: Date.now() - startedAt,
      ...sub,
    });
  } catch (err) {
    return formatToolError('bg_diagnostics_subscribe', startedAt, err);
  }
}

/** `bg_read_console`. */
async function callReadConsole(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client, ownerKey } = resolveTarget(state, args);
    const buf = state.diagBuffers.get(`${ownerKey}:${client.targetId}`);
    const consoleEntries = buf?.console ?? [];
    const errorEntries = buf?.errors ?? [];
    const summary =
      consoleEntries.length === 0 && errorEntries.length === 0
        ? `No console entries collected for ${client.targetId} yet. Call bg_diagnostics_subscribe first if that has not been done.`
        : `${consoleEntries.length} console entr${consoleEntries.length === 1 ? 'y' : 'ies'}, ${errorEntries.length} page error${errorEntries.length === 1 ? '' : 's'} for ${client.targetId}.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_read_console',
      durationMs: Date.now() - startedAt,
      targetId: client.targetId,
      console: consoleEntries,
      errors: errorEntries,
    });
  } catch (err) {
    return formatToolError('bg_read_console', startedAt, err);
  }
}

/** `bg_read_network`. */
async function callReadNetwork(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client, ownerKey } = resolveTarget(state, args);
    const buf = state.diagBuffers.get(`${ownerKey}:${client.targetId}`);
    const requests = buf?.network ?? [];
    const summary =
      requests.length === 0
        ? `No network rows collected for ${client.targetId} yet. Call bg_diagnostics_subscribe with network true if that has not been done.`
        : `${requests.length} network row(s) for ${client.targetId}.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_read_network',
      durationMs: Date.now() - startedAt,
      targetId: client.targetId,
      requests,
    });
  } catch (err) {
    return formatToolError('bg_read_network', startedAt, err);
  }
}

/** `bg_wait_for_network_idle`, wrapping `client.waitForNetworkIdle()`. */
async function callWaitForNetworkIdle(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const maxInflight = args['maxInflight'];
    const idleMs = args['idleMs'];
    const timeoutMs = args['timeoutMs'];
    await client.waitForNetworkIdle({
      ...(typeof maxInflight === 'number' ? { maxInflight } : {}),
      ...(typeof idleMs === 'number' ? { idleMs } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    return formatToolResult('Network reached idle.', {
      ok: true,
      action: 'bg_wait_for_network_idle',
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    return formatToolError('bg_wait_for_network_idle', startedAt, err);
  }
}

/**
 * `bg_page_map`. One tool, two actions, because they are two halves of one
 * flow: `client.pageMap()` for "capture", `client.stampPageMap()` for
 * "stamp"; see the tool's own manifest description for the full argument
 * on each. The capture branch's plain-text body is `formatPageMapCapture()`
 * (`./format.js`); the trailer deliberately carries counts and the
 * degradation record but never a second copy of `nodes` (that module's own
 * doc explains why). The stamp branch's reply is small enough (a caller
 * asks for specific indices, never "all of them") that its `results` array
 * goes straight into the trailer with no separate rendering.
 */
async function callPageMap(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const { client } = resolveTarget(state, args);
    const action = args['action'];

    if (action === 'stamp') {
      const epoch = requireString(args, 'epoch');
      const indicesArg = args['indices'];
      if (
        !Array.isArray(indicesArg) ||
        indicesArg.length === 0 ||
        indicesArg.some((v) => typeof v !== 'number')
      ) {
        throw new Error("'indices' must be a non-empty array of numbers");
      }
      const indices = indicesArg as number[];
      const result = await client.stampPageMap(epoch, indices);
      const stampedCount = result.results.filter((r) => r.stamped).length;
      const summary = result.marker
        ? `Stamped ${stampedCount} of ${indices.length} index(es) with marker '${result.marker}'. Address a stamped element as selector "css=[${result.marker}]".`
        : `Stamped 0 of ${indices.length} index(es); nothing was written.`;
      return formatToolResult(summary, {
        ok: true,
        action: 'bg_page_map',
        durationMs: Date.now() - startedAt,
        epoch,
        marker: result.marker,
        results: result.results,
      });
    }

    const include = args['include'];
    const listeners = args['listeners'];
    const timeoutMs = args['timeoutMs'];
    const result = await client.pageMap({
      ...(Array.isArray(include) ? { include: include as ('nodes' | 'text')[] } : {}),
      ...(typeof listeners === 'boolean' ? { listeners } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
    const summary = formatPageMapCapture(result);
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_page_map',
      durationMs: Date.now() - startedAt,
      epoch: result.epoch,
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
      ...(result.truncatedByReason !== undefined
        ? { truncatedByReason: result.truncatedByReason }
        : {}),
      ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
    });
  } catch (err) {
    return formatToolError('bg_page_map', startedAt, err);
  }
}

// ==================================================================
// Swarm lifecycle: open, list, grow, shrink, close.
// ==================================================================

/** `bg_swarm_open`. */
async function callSwarmOpen(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    if (!state.swarmAcquire) {
      throw AutomationError.notImplemented(
        'bg_swarm_open',
        'a way to open browsers: construct this MCP server with options.swarm.acquire to enable the swarm tools',
      );
    }
    const size = args['size'];
    if (typeof size !== 'number') throw new Error("bg_swarm_open needs 'size' as a number");
    const url = args['url'];
    const isolation = args['isolation'];
    const subject = args['subject'];
    const stickyWithinMs = args['stickyWithinMs'];
    if (subject !== undefined && (typeof subject !== 'string' || subject.length === 0)) {
      throw new Error(
        "bg_swarm_open's 'subject', when given, must be a non-empty string naming who these browsers belong to",
      );
    }
    const swarm = await BrowserSwarm.open({
      size,
      acquire: state.swarmAcquire,
      ...(typeof url === 'string' ? { url } : {}),
      ...(typeof isolation === 'string' ? { isolation: isolation as 'tab' | 'window' } : {}),
      ...(typeof subject === 'string' ? { subject } : {}),
      ...(typeof stickyWithinMs === 'number' ? { stickyWithinMs } : {}),
      ...(state.swarmTransport !== undefined ? { transport: state.swarmTransport } : {}),
    });
    const swarmId = `swarm_${state.nextSwarmId++}`;
    state.swarms.set(swarmId, swarm);
    const members = swarm.members.map((m) => ({
      index: m.index,
      instanceId: m.instanceId,
      targetId: m.targetId,
      subject: m.subject,
    }));
    // The summary line says which of the two behaviours the agent actually
    // got. An agent that meant to reattach and instead launched `size`
    // fresh browsers has no other way to notice, and the instanceIds alone
    // do not tell it: they are the same ids either way.
    const ownership =
      swarm.subject === undefined
        ? 'freshly launched, owned by no one, gone after bg_swarm_close'
        : `owned by "${swarm.subject}", so the same subject reattaches to these same browsers next time`;
    return formatToolResult(
      `Opened swarm ${swarmId} with ${members.length} member(s), ${ownership}.`,
      {
        ok: true,
        action: 'bg_swarm_open',
        durationMs: Date.now() - startedAt,
        swarmId,
        subject: swarm.subject ?? null,
        members,
      },
    );
  } catch (err) {
    return formatToolError('bg_swarm_open', startedAt, err);
  }
}

/** `bg_swarm_list`. */
async function callSwarmList(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const swarmId = args['swarmId'];
    if (typeof swarmId === 'string' && swarmId.length > 0) {
      const swarm = getSwarm(state, swarmId);
      // Which member a person is on is reported here, per member, because
      // this is the tool an agent calls to work out what its twenty
      // browsers are doing. A yield on one member changes nothing for the
      // other nineteen (separate connections, separate leases), so the
      // useful thing to say is not "the swarm was interrupted" but exactly
      // which slot to leave alone.
      const yieldedByIndex = new Map(swarm.yielded().map((y) => [y.member.index, y.notice]));
      const members = swarm.members.map((m) => {
        const notice = yieldedByIndex.get(m.index);
        return {
          index: m.index,
          instanceId: m.instanceId,
          targetId: m.targetId,
          subject: m.subject,
          ...(notice !== undefined
            ? {
                yielded: true,
                humanTookOver: notice.human,
                yieldedTo: notice.byLabel,
                resumeNotBefore: notice.resumeNotBefore,
              }
            : {}),
        };
      });
      const takenOver =
        yieldedByIndex.size === 0
          ? ''
          : ` ${yieldedByIndex.size} member(s) have been taken over: leave those alone.`;
      return formatToolResult(
        `Swarm ${swarmId} has ${members.length} member(s)${swarm.subject === undefined ? '' : `, owned by "${swarm.subject}"`}.${takenOver}`,
        {
          ok: true,
          action: 'bg_swarm_list',
          durationMs: Date.now() - startedAt,
          swarmId,
          subject: swarm.subject ?? null,
          members,
        },
      );
    }
    const swarms = [...state.swarms.entries()].map(([id, s]) => ({
      swarmId: id,
      size: s.members.length,
      subject: s.subject ?? null,
    }));
    return formatToolResult(`${swarms.length} open swarm(s).`, {
      ok: true,
      action: 'bg_swarm_list',
      durationMs: Date.now() - startedAt,
      swarms,
    });
  } catch (err) {
    return formatToolError('bg_swarm_list', startedAt, err);
  }
}

/** `bg_swarm_grow`. */
async function callSwarmGrow(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const swarmId = requireString(args, 'swarmId');
    const swarm = getSwarm(state, swarmId);
    const n = args['n'];
    if (typeof n !== 'number') throw new Error("bg_swarm_grow needs 'n' as a number");
    const added = await swarm.grow(n);
    const members = added.map((m) => ({
      index: m.index,
      instanceId: m.instanceId,
      targetId: m.targetId,
      subject: m.subject,
    }));
    return formatToolResult(
      `Grew swarm ${swarmId} by ${members.length}; ${swarm.members.length} member(s) total.`,
      {
        ok: true,
        action: 'bg_swarm_grow',
        durationMs: Date.now() - startedAt,
        swarmId,
        added: members,
      },
    );
  } catch (err) {
    return formatToolError('bg_swarm_grow', startedAt, err);
  }
}

/** `bg_swarm_shrink`. */
async function callSwarmShrink(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const swarmId = requireString(args, 'swarmId');
    const swarm = getSwarm(state, swarmId);
    const n = args['n'];
    if (typeof n !== 'number') throw new Error("bg_swarm_shrink needs 'n' as a number");
    await swarm.shrink(n);
    return formatToolResult(
      `Shrank swarm ${swarmId} by ${n}; ${swarm.members.length} member(s) remain.`,
      {
        ok: true,
        action: 'bg_swarm_shrink',
        durationMs: Date.now() - startedAt,
        swarmId,
        remaining: swarm.members.length,
      },
    );
  } catch (err) {
    return formatToolError('bg_swarm_shrink', startedAt, err);
  }
}

/** `bg_swarm_close`. */
async function callSwarmClose(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const swarmId = requireString(args, 'swarmId');
    const swarm = getSwarm(state, swarmId);
    await swarm.close();
    state.swarms.delete(swarmId);
    // Forget this swarm's own diagnostic buffers and listener registrations
    // too, or they sit around forever keyed under a swarmId bg_swarm_list
    // will never surface again.
    const prefix = `${swarmId}:`;
    for (const key of [...state.diagBuffers.keys()])
      if (key.startsWith(prefix)) state.diagBuffers.delete(key);
    for (const key of [...state.diagListenersAttached])
      if (key.startsWith(prefix)) state.diagListenersAttached.delete(key);
    return formatToolResult(`Closed swarm ${swarmId}.`, {
      ok: true,
      action: 'bg_swarm_close',
      durationMs: Date.now() - startedAt,
      swarmId,
    });
  } catch (err) {
    return formatToolError('bg_swarm_close', startedAt, err);
  }
}

/**
 * Runs one `bg_swarm_run` action against one member. `navigate`/`click`/`type`
 * each acquire that member's own lease, run the action, and release it
 * again: the same acquire-do-release shape `BrowserSwarm`'s own README
 * example and `openOneMember()`'s `opts.url` handling use, so a member is
 * never left holding control after one fan-out call just because it was
 * asked to do something on it.
 */
async function runOneSwarmAction(
  member: SwarmMember,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case 'navigate': {
      const url = requireString(args, 'url');
      const lease = await member.client.acquireControl();
      try {
        return await member.client.navigate(url);
      } finally {
        await lease.release();
      }
    }
    case 'click': {
      const x = args['x'];
      const y = args['y'];
      if (typeof x !== 'number' || typeof y !== 'number')
        throw new Error("bg_swarm_run's 'click' action needs x and y");
      const button = args['button'];
      const clickCount = args['clickCount'];
      const lease = await member.client.acquireControl();
      try {
        await member.client.clickAt(x, y, {
          ...(typeof button === 'string' ? { button: button as 'left' | 'right' | 'middle' } : {}),
          ...(typeof clickCount === 'number' ? { clickCount } : {}),
        });
        return { clickedAt: [x, y] };
      } finally {
        await lease.release();
      }
    }
    case 'type': {
      const text = requireString(args, 'text');
      const lease = await member.client.acquireControl();
      try {
        await member.client.type(text);
        return { typed: text.length };
      } finally {
        await lease.release();
      }
    }
    case 'screenshot':
      return member.client.screenshot();
    case 'status':
      return member.client.status();
    default:
      throw new Error(
        `bg_swarm_run: unknown action '${action}'; expected navigate, click, type, screenshot, or status`,
      );
  }
}

/** `bg_swarm_run`, the fan-out tool. Genuinely concurrent: `BrowserSwarm.all()` is `Promise.allSettled` over every member, not a loop, so this never waits on one member before starting the next. */
async function callSwarmRun(
  state: McpServerState,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    const swarmId = requireString(args, 'swarmId');
    const action = requireString(args, 'action');
    const swarm = getSwarm(state, swarmId);
    // Snapshotted before all() runs so a concurrent grow()/shrink() call
    // (unusual mid-fan-out, but not forbidden) cannot desync this array
    // from the one all() itself mapped over.
    const members = swarm.members;
    const settled = await swarm.all((member) => runOneSwarmAction(member, action, args));
    const perMember = settled.map((r, index) => {
      const member = members[index];
      if (r.status === 'fulfilled')
        return { index, instanceId: member?.instanceId, ok: true, result: r.value };
      const wrapped =
        r.reason instanceof AutomationError
          ? r.reason
          : new AutomationError(
              'PROTOCOL_ERROR',
              r.reason instanceof Error ? r.reason.message : String(r.reason),
            );
      return {
        index,
        instanceId: member?.instanceId,
        ok: false,
        code: wrapped.code,
        message: wrapped.message,
      };
    });
    const okCount = perMember.filter((m) => m.ok).length;
    const summary = `${action} ran on ${perMember.length} member(s) of ${swarmId} concurrently: ${okCount} ok, ${perMember.length - okCount} failed.`;
    return formatToolResult(summary, {
      ok: true,
      action: 'bg_swarm_run',
      durationMs: Date.now() - startedAt,
      swarmId,
      memberAction: action,
      results: perMember,
    });
  } catch (err) {
    return formatToolError('bg_swarm_run', startedAt, err);
  }
}

/**
 * Dispatches one MCP `tools/call` to the manifest above. Exported
 * separately from {@link createAutomationMcpServer} so a test can exercise
 * every tool's result shape directly, with no stdio transport involved.
 * Takes the same `McpServerState` a real server builds once at construction
 * (see {@link createAutomationMcpServer}); a test that only needs the
 * original single-target tools can build one with `createMcpStateForTest()`
 * below rather than reaching into this module's private state shape.
 */
export async function callAutomationTool(
  state: McpServerState,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  switch (name) {
    case 'bg_status':
      return callStatus(state, args);
    case 'bg_read_page':
      return callReadPage(state, args);
    case 'bg_click':
      return callClick(state, args);
    case 'bg_type':
      return callType(state, args);
    case 'bg_set_input_files':
      return callSetInputFiles(state, args);
    case 'bg_control':
      return callControl(state, args);
    case 'bg_navigate':
      return callNavigate(state, args);
    case 'bg_screenshot':
      return callScreenshot(state, args);
    case 'bg_pdf':
      return callPdf(state, args);
    case 'bg_recording':
      return callRecording(state, args);
    case 'bg_back':
      return callBack(state, args);
    case 'bg_forward':
      return callForward(state, args);
    case 'bg_reload':
      return callReload(state, args);
    case 'bg_stop':
      return callStop(state, args);
    case 'bg_press_key':
      return callPressKey(state, args);
    case 'bg_scroll':
      return callScroll(state, args);
    case 'bg_wait_for_navigation':
      return callWaitForNavigation(state, args);
    case 'bg_tabs':
      return callTabs(state, args);
    case 'bg_evaluate':
      return callEvaluate(state, args);
    case 'bg_resolve':
      return callResolve(state, args);
    case 'bg_wait_for':
      return callWaitFor(state, args);
    case 'bg_wait_for_text':
      return callWaitForText(state, args);
    case 'bg_get_text':
      return callGetText(state, args);
    case 'bg_get_attribute':
      return callGetAttribute(state, args);
    case 'bg_is_checked':
      return callIsChecked(state, args);
    case 'bg_get_html':
      return callGetHtml(state, args);
    case 'bg_scroll_into_view':
      return callScrollIntoView(state, args);
    case 'bg_fill':
      return callFill(state, args);
    case 'bg_select':
      return callSelect(state, args);
    case 'bg_diagnostics_subscribe':
      return callDiagnosticsSubscribe(state, args);
    case 'bg_read_console':
      return callReadConsole(state, args);
    case 'bg_read_network':
      return callReadNetwork(state, args);
    case 'bg_wait_for_network_idle':
      return callWaitForNetworkIdle(state, args);
    case 'bg_page_map':
      return callPageMap(state, args);
    case 'bg_swarm_open':
      return callSwarmOpen(state, args);
    case 'bg_swarm_list':
      return callSwarmList(state, args);
    case 'bg_swarm_grow':
      return callSwarmGrow(state, args);
    case 'bg_swarm_shrink':
      return callSwarmShrink(state, args);
    case 'bg_swarm_close':
      return callSwarmClose(state, args);
    case 'bg_swarm_run':
      return callSwarmRun(state, args);
    default:
      return formatToolError(name, Date.now(), new Error(`unknown tool '${name}'`));
  }
}

/**
 * Builds the `McpServerState` {@link callAutomationTool} needs, for a test
 * that wants to call tools directly without going through a real `Server`
 * or `StdioServerTransport`. `createAutomationMcpServer()` below builds the
 * same shape internally; this is exported so `test/mcp/*.test.ts` has a
 * supported way to do the same rather than reaching into this module's
 * otherwise-private state.
 */
export function createMcpStateForTest(options: AutomationMcpServerOptions): McpServerState {
  return createMcpState(options);
}

/**
 * Builds the MCP `Server` for `@browserglass/automation` (token-pinned
 * session binding: one `AutomationClient` bound at
 * construction for the single-target tools, with `bg_swarm_*` layered on
 * top for driving more than one browser). Connect it to a transport
 * (`StdioServerTransport` for a CLI-spawned agent process, per the SDK's
 * own `server/stdio.js`) to actually serve requests; this function only
 * builds and wires the `Server`, it does not connect one.
 *
 * Sets `server.onclose` to close every swarm this server itself opened:
 * an agent that opens a swarm and forgets `bg_swarm_close` is the expected
 * failure mode, not an edge case, so that leak should last only until this
 * connection ends, not for the life of whatever process hosts it. The SDK's
 * `Protocol#onclose` (`Server` extends `Protocol`) fires on an explicit
 * `server.close()` and on the transport disconnecting, which is the one
 * point a stdio-spawned agent process exiting reliably reaches. A caller
 * that needs its own `onclose` too should chain it, e.g.
 * `const prior = server.onclose; server.onclose = () => { prior?.(); myCleanup(); };`,
 * rather than overwriting this one and losing the swarm cleanup.
 */
export function createAutomationMcpServer(options: AutomationMcpServerOptions): Server {
  const state = createMcpState(options);
  const server = new Server(
    { name: options.name ?? '@browserglass/automation', version: options.version ?? '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AUTOMATION_MCP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callAutomationTool(state, request.params.name, args);
    return result as CallToolResult;
  });

  server.onclose = () => {
    const swarms = [...state.swarms.values()];
    state.swarms.clear();
    for (const swarm of swarms) {
      // BrowserSwarm.close() already swallows per-member socket errors
      // (swarm.ts's own closeMembers()), so this needs no retry of its
      // own; onclose itself is synchronous, so the close is fire-and-forget.
      swarm.close().catch(() => {});
    }
  };

  return server;
}
