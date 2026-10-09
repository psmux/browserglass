/**
 * `@browserglass/embed`: `<browser-glass>`, a self-contained custom
 * element for dropping a live, drivable BrowserGlass pane into any HTML
 * page with one script tag. No React, no bundler, no module loader
 * required at the call site.
 *
 * Importing this module (from a `<script type="module">`, or via the
 * IIFE build's `<script src="...">`, both produced by `tsup.config.ts`
 * from this same file) registers `<browser-glass>` in
 * `customElements` as a side effect, exactly once: `customElements.define`
 * throws if called twice for the same name, which would otherwise be an
 * easy way for a host page that (accidentally or deliberately) loads this
 * script more than once to crash instead of just being a harmless no-op
 * the second time.
 *
 * `package.json` declares `"sideEffects": true` for this reason: a
 * bundler is not free to tree-shake this import away on the (correct, for
 * most modules) assumption that importing something unused has no effect.
 */
import { BrowserGlassElement } from './element.js';
import type { BrowserGlassEventDetailMap } from './events.js';

export { BrowserGlassElement } from './element.js';
export type {
  BrowserGlassConnectedDetail,
  BrowserGlassConsoleDetail,
  BrowserGlassControlGainedDetail,
  BrowserGlassControlLostDetail,
  BrowserGlassDisconnectedDetail,
  BrowserGlassErrorDetail,
  BrowserGlassEventDetailMap,
  BrowserGlassNavigationDetail,
  BrowserGlassPageErrorDetail,
} from './events.js';

if (typeof customElements !== 'undefined' && !customElements.get('browser-glass')) {
  customElements.define('browser-glass', BrowserGlassElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'browser-glass': BrowserGlassElement;
  }
  // Lets `el.addEventListener('bgls:connected', (e) => ...)` infer `e` as a
  // `CustomEvent<BrowserGlassConnectedDetail>` on any `HTMLElement`, not
  // only on a statically typed `BrowserGlassElement`, since the events
  // bubble (`composed: true`) up through plain ancestor elements a host
  // page is far more likely to attach its listener to than the widget
  // itself.
  interface HTMLElementEventMap {
    'bgls:connected': CustomEvent<BrowserGlassEventDetailMap['bgls:connected']>;
    'bgls:disconnected': CustomEvent<BrowserGlassEventDetailMap['bgls:disconnected']>;
    'bgls:controlgained': CustomEvent<BrowserGlassEventDetailMap['bgls:controlgained']>;
    'bgls:controllost': CustomEvent<BrowserGlassEventDetailMap['bgls:controllost']>;
    'bgls:console': CustomEvent<BrowserGlassEventDetailMap['bgls:console']>;
    'bgls:pageerror': CustomEvent<BrowserGlassEventDetailMap['bgls:pageerror']>;
    'bgls:navigation': CustomEvent<BrowserGlassEventDetailMap['bgls:navigation']>;
    'bgls:error': CustomEvent<BrowserGlassEventDetailMap['bgls:error']>;
  }
}
