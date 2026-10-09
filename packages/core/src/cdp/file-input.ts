/**
 * `DOM.setFileInputFiles`: attaching already-staged files to an
 * `<input type="file">` in a live page. This is the CDP half of the
 * upload feature; the transfer half (getting a caller's bytes onto the
 * machine Chrome runs on) lives in `@browserglass/server`'s
 * `src/files/upload-store.ts`, because it is filesystem work and this
 * package touches no disk.
 *
 * WHY `DOM.setFileInputFiles` AND NOT `Page.fileChooserOpened`
 *
 * CDP offers two ways to put a file into a page. `DOM.setFileInputFiles`
 * names an element directly and sets its `FileList`. The interception
 * style (`Page.setInterceptFileChooserDialog`, then answering the
 * `Page.fileChooserOpened` event) waits for the page itself to open a
 * native chooser and then answers it.
 *
 * Interception is the right mechanism for a HUMAN driving a remote
 * browser: a person clicks "Browse", the node intercepts the chooser it
 * would otherwise pop up on the wrong machine, and the viewer's own
 * browser is asked for a file instead. That is what this protocol's
 * `filechooser.opened`/`filechooser.answer` message pair is for, and it
 * needs a long lived per target subscription plus a chooser id lifecycle.
 *
 * Direct attachment is the right mechanism for an AGENT, which is the
 * caller this build has. It is request and response with no waiting on a
 * page event, which is exactly the shape a REST route can serve; it is
 * what Playwright's own `set_input_files` does; and it works on inputs a
 * page never opens a chooser for, which covers the common case of a
 * visually hidden input driven by a styled label. So this module
 * implements direct attachment, and the interception path stays typed
 * only.
 *
 * WHY NO `Runtime.evaluate`
 *
 * The element is resolved with `DOM.getDocument` plus `DOM.querySelector`,
 * both of which take a selector STRING that Chrome parses as a selector
 * and never as script. Resolving the same element by evaluating
 * `document.querySelector(...)` would work equally well and would drag
 * this feature behind whatever policy governs arbitrary page evaluation,
 * for no benefit. Attaching a file is its own privilege and is gated on
 * its own capability (`upload`); it must not require, or quietly grant,
 * script execution.
 *
 * KNOWN LIMITS, stated rather than hidden
 *
 * `DOM.querySelector` searches one document. An input inside an iframe or
 * inside a closed shadow root is not reachable through this call, and this
 * module reports "no element matched" for it rather than pretending
 * otherwise. Frame scoped and shadow piercing lookups need the locator
 * engine, which is a separate piece of work.
 */

import type { CdpBridge } from './bridge.js';
import type { CdpSessionId } from './types.js';

/** Why {@link setFileInputFiles} refused, when it refused for a reason the caller can act on. */
export type FileInputFailure =
  /** `DOM.querySelector` matched nothing. Includes the iframe and shadow-root cases named in this module's doc. */
  | 'no_match'
  /** The element matched but is not an `<input type="file">`. Sending `DOM.setFileInputFiles` at it would fail with an opaque protocol error, so it is refused here with a specific one. */
  | 'not_a_file_input'
  /** More than one file was offered to an input without the `multiple` attribute. Chrome would silently keep only the first; refusing is more honest. */
  | 'not_multiple';

/** Thrown by {@link setFileInputFiles} for a refusal the caller can act on. Any other failure (a dead session, a CDP protocol error) propagates unchanged from the bridge. */
export class FileInputError extends Error {
  readonly code = 'E_FILE_INPUT';
  readonly reason: FileInputFailure;
  readonly selector: string;
  constructor(reason: FileInputFailure, selector: string, message: string) {
    super(message);
    this.name = 'FileInputError';
    this.reason = reason;
    this.selector = selector;
  }
}

/** What {@link setFileInputFiles} needs beyond the bridge and session. */
export interface SetFileInputFilesRequest {
  /** A CSS selector, resolved against the target's main document with `DOM.querySelector`. Never evaluated as script. */
  readonly selector: string;
  /**
   * Absolute paths on the machine running Chrome, in the order the page
   * should see them.
   *
   * Every caller of this function is responsible for having BUILT these
   * paths itself rather than accepting them from whoever asked for the
   * upload. This module cannot check that (a path is a path by the time it
   * gets here), which is precisely why the only production caller,
   * `@browserglass/server`'s `ManagedSession.setInputFiles`, resolves them
   * from staging ids and never from request fields.
   */
  readonly files: readonly string[];
}

/** `DOM.describeNode`'s answer, narrowed to the two fields this module reads. */
interface DescribedNode {
  readonly node?: {
    readonly nodeName?: string;
    /** Flat `[name, value, name, value, ...]` list, CDP's own shape. */
    readonly attributes?: readonly string[];
  };
}

/** Reads one attribute out of `DOM.describeNode`'s flat attribute list. Returns `null` for an attribute that is absent, `''` for one present with an empty value (which is how `multiple` appears). */
function attribute(node: DescribedNode, name: string): string | null {
  const attrs = node.node?.attributes;
  if (!attrs) return null;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i]?.toLowerCase() === name) return attrs[i + 1] ?? '';
  }
  return null;
}

/**
 * Attaches `req.files` to the `<input type="file">` matching
 * `req.selector` in the page behind `sessionId`.
 *
 * Four CDP round trips, in this order and for these reasons:
 *
 * 1. `DOM.getDocument` with `depth: 0`. Also the call that enables the DOM
 *    agent, so no separate `DOM.enable` is needed, and it returns the root
 *    node id `DOM.querySelector` has to be rooted at. `depth: 0` keeps
 *    Chrome from serialising the whole tree back for a lookup that only
 *    needs the root's id.
 * 2. `DOM.querySelector`. A `nodeId` of `0` is CDP's "no match"; it is not
 *    an error, so it has to be checked for explicitly.
 * 3. `DOM.describeNode`, to verify the match really is a file input before
 *    step 4. Skipping this is tempting (Chrome will refuse anyway) but the
 *    refusal is a bare protocol error naming neither the selector nor what
 *    was wrong with it, which turns a caller's typo into an unreadable
 *    failure.
 * 4. `DOM.setFileInputFiles`.
 *
 * The files are NOT read here and their bytes are not sent anywhere.
 * Chrome opens each path lazily, when the page reads the `File` (a
 * `FileReader`, a `fetch` body, or a form submission), which can be
 * minutes after this call returns. Deleting the staged file the moment
 * this resolves therefore breaks the upload it was meant to perform; see
 * the staging TTL in `@browserglass/server`'s `src/files/upload-store.ts`
 * for how long they are kept and why.
 */
export async function setFileInputFiles(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  req: SetFileInputFilesRequest,
): Promise<void> {
  const doc = (await bridge.send('DOM.getDocument', { depth: 0 }, sessionId)) as {
    root?: { nodeId?: number };
  };
  const rootNodeId = doc.root?.nodeId;
  if (typeof rootNodeId !== 'number') {
    throw new FileInputError(
      'no_match',
      req.selector,
      'DOM.getDocument returned no root node for this target',
    );
  }

  const found = (await bridge.send(
    'DOM.querySelector',
    { nodeId: rootNodeId, selector: req.selector },
    sessionId,
  )) as { nodeId?: number };
  const nodeId = found.nodeId;
  if (typeof nodeId !== 'number' || nodeId === 0) {
    throw new FileInputError(
      'no_match',
      req.selector,
      `no element matched ${JSON.stringify(req.selector)} in this target's main document (an input inside an iframe or a closed shadow root is not reachable this way)`,
    );
  }

  const described = (await bridge.send('DOM.describeNode', { nodeId }, sessionId)) as DescribedNode;
  const nodeName = described.node?.nodeName?.toUpperCase() ?? '';
  const type = attribute(described, 'type')?.toLowerCase() ?? null;
  if (nodeName !== 'INPUT' || type !== 'file') {
    throw new FileInputError(
      'not_a_file_input',
      req.selector,
      `${JSON.stringify(req.selector)} matched <${nodeName.toLowerCase() || 'unknown'}${type === null ? '' : ` type="${type}"`}>, which is not an <input type="file">`,
    );
  }
  if (req.files.length > 1 && attribute(described, 'multiple') === null) {
    throw new FileInputError(
      'not_multiple',
      req.selector,
      `${JSON.stringify(req.selector)} has no "multiple" attribute, so it cannot accept ${req.files.length} files`,
    );
  }

  await bridge.send('DOM.setFileInputFiles', { nodeId, files: [...req.files] }, sessionId);
}
