/**
 * Client hints (`navigator.userAgentData` and the `Sec-CH-UA*` headers) that agree with a user agent string,
 * built the way Chrome builds its own.
 *
 * Two cases need them. A headless launch gets the headful user agent through `--user-agent`
 * (`runtime-host/src/flags.ts`), and with that switch set headless Chrome leaves the high entropy hints empty
 * (platform version, architecture, full version list). And `Emulation.setUserAgentOverride` sent without
 * `userAgentMetadata` empties `navigator.userAgentData` altogether. Real Chrome shows neither, so both are tells.
 */
import { arch, release } from 'node:os';

/**
 * Chrome's brand list for a major version, as Chromium makes it (components/embedder_support/user_agent_utils.cc,
 * GenerateBrandVersionList): a made up "Not A Brand" entry whose spelling, version and place all follow from the
 * major version, then Chromium and the product brand.
 */
export function brandList(major: number, brand = 'Google Chrome', full?: string): { brand: string; version: string }[] {
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const;
  const order = orders[major % 6]!;
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = ['8', '99', '24'][major % 3]!;
  // With `full`, the shape of fullVersionList: every version in four parts.
  const list: { brand: string; version: string }[] = [];
  list[order[0]] = { brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`, version: full ? `${grease}.0.0.0` : grease };
  list[order[1]] = { brand: 'Chromium', version: full ?? String(major) };
  list[order[2]] = { brand, version: full ?? String(major) };
  return list;
}

/**
 * The platform version Chrome reports for the machine this process runs on: on Windows the Universal API
 * contract version Microsoft maps each Windows build to, on macOS the macOS version, on Linux the kernel version.
 */
export function hostPlatformVersion(platform: NodeJS.Platform = process.platform, rel: string = release()): string {
  if (platform === 'win32') {
    const build = Number(rel.split('.')[2] ?? 0);
    if (build >= 26100) return '19.0.0';
    if (build >= 22621) return '15.0.0';
    if (build >= 22000) return '14.0.0';
    if (build >= 19041) return '10.0.0';
    return '0.0.0';
  }
  if (platform === 'darwin') {
    const [maj = 0, min = 0] = rel.split('.').map(Number);
    // Darwin 20 to 24 are macOS 11 to 15; Darwin 25 is macOS 26.
    const mac = maj >= 25 ? maj + 1 : maj - 9;
    return `${mac}.${min}.0`;
  }
  return rel.split('-')[0] ?? '';
}

/** What a user agent string says about the platform, in client hint terms. */
function platformOf(ua: string): { platform: string; mobile: boolean } {
  if (/Android/.test(ua)) return { platform: 'Android', mobile: /Mobile/.test(ua) };
  if (/iPhone|iPad|iPod/.test(ua)) return { platform: 'iOS', mobile: !/iPad/.test(ua) };
  if (/CrOS/.test(ua)) return { platform: 'Chrome OS', mobile: false };
  if (/Mac OS X|Macintosh/.test(ua)) return { platform: 'macOS', mobile: false };
  if (/Windows/.test(ua)) return { platform: 'Windows', mobile: false };
  return { platform: 'Linux', mobile: false };
}

const HOST_PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * `userAgentMetadata` for `Emulation.setUserAgentOverride` that matches `userAgent`. `fullVersion` is the
 * running Chrome's full version (`Browser.getVersion`'s product), used for the full version list. The platform
 * version and architecture are this machine's when the user agent names this machine's platform, and empty
 * otherwise (an emulated phone on a desktop), which is what Chrome reports when it cannot tell.
 */
export function clientHintsFor(userAgent: string, fullVersion: string): Record<string, unknown> {
  const major = Number(/Chrome\/(\d+)/.exec(userAgent)?.[1] ?? fullVersion.split('.')[0] ?? 0);
  const full = fullVersion.split('.')[0] === String(major) ? fullVersion : `${major}.0.0.0`;
  const { platform, mobile } = platformOf(userAgent);
  const local = HOST_PLATFORM[process.platform] === platform;
  return {
    brands: brandList(major),
    fullVersionList: brandList(major, 'Google Chrome', full),
    fullVersion: full,
    platform,
    platformVersion: local ? hostPlatformVersion() : '',
    architecture: local ? (arch() === 'arm64' ? 'arm' : 'x86') : '',
    bitness: local ? '64' : '',
    model: platform === 'Android' ? (/Android[^;]*;\s*([^;)]+)/.exec(userAgent)?.[1]?.trim() ?? '') : '',
    mobile,
    wow64: false,
    formFactors: [mobile ? 'Mobile' : 'Desktop'],
  };
}

/** Headless Chrome's own user agent with the headless marker taken out, the agent a headful window sends. */
export function withoutHeadless(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome\//, 'Chrome/').replace(/Headless/g, '');
}
