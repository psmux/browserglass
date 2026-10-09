/**
 * The launch argument deny and allow lists, versioned here so every runtime adapter screens
 * `BrowserSpec.extraArgs` and any operator supplied extra arguments through
 * the same list. Deny wins over allow; anything not on the allow list is
 * rejected. Operators may extend the allow list in node config; apps may
 * not, under any token claim.
 */

/**
 * Argument patterns no `extraArgs` entry may match, security boundaries
 * rather than style preferences. Several execute an arbitrary command
 * (`--renderer-cmd-prefix`, `--gpu-launcher`, `--utility-cmd-prefix`);
 * others defeat egress or credential policy, or duplicate a field
 * `BrowserSpec` already controls.
 */
export const ARG_DENY: readonly RegExp[] = [
  /^--user-data-dir(=|$)/,
  /^--remote-debugging-(port|address|pipe)(=|$)/,
  /^--remote-allow-origins(=|$)/,
  /^--no-sandbox$/,
  /^--disable-setuid-sandbox$/,
  /^--disable-web-security$/,
  /^--allow-running-insecure-content$/,
  /^--ignore-certificate-errors/,
  /^--load-extension(=|$)/,
  /^--disable-extensions-except(=|$)/,
  /^--proxy-server(=|$)/,
  /^--proxy-pac-url(=|$)/,
  /^--host-resolver-rules(=|$)/,
  /^--auth-server-(allowlist|whitelist)(=|$)/,
  /^--unsafely-treat-insecure-origin-as-secure(=|$)/,
  /^--headless/,
  /^--disable-features=.*(IsolateOrigins|SitePerProcess)/,
  /^--renderer-cmd-prefix(=|$)/,
  /^--gpu-launcher(=|$)/,
  /^--utility-cmd-prefix(=|$)/,
  /^--no-zygote$/,
] as const;

/**
 * The small, boring set of argument patterns an `extraArgs` entry may
 * match once it has cleared `ARG_DENY`: window and display flags, known
 * safe feature toggles, language and font flags, and a fixed set of
 * memory sizing `--js-flags`.
 */
export const ARG_ALLOW: readonly RegExp[] = [
  // GL backend selection. Headful Chrome under Xvfb otherwise ends up with
  // --disable-gpu after one GPU-init failure and exposes NO WebGL at all (a loud automation tell).
  /^--use-gl=(angle|egl)$/,
  /^--use-angle=(vulkan|swiftshader|gl|default)$/,
  /^--enable-features=[A-Za-z0-9_,]+$/,
  /^--ignore-gpu-blocklist$/,
  /^--enable-unsafe-swiftshader$/,
  /^--window-size=\d+,\d+$/,
  /^--window-position=-?\d+,-?\d+$/,
  /^--hide-scrollbars$/,
  /^--mute-audio$/,
  /^--force-color-profile=\w+$/,
  /^--disable-dev-shm-usage$/,
  /^--disable-gpu$/,
  /^--font-render-hinting=(none|slight|medium|full)$/,
  /^--lang=[A-Za-z-]+$/,
  /^--js-flags=--max-old-space-size=\d+$/,
] as const;

/**
 * Screens one candidate launch argument against `ARG_DENY` and `ARG_ALLOW`.
 * Deny always wins; an argument matching neither list is rejected.
 */
export function isArgAllowed(arg: string): boolean {
  for (const pattern of ARG_DENY) if (pattern.test(arg)) return false;
  for (const pattern of ARG_ALLOW) if (pattern.test(arg)) return true;
  return false;
}
