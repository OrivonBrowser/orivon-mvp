// The User-Agent every web page in this browser sees: plain Chrome, for the
// Chromium this build runs on. Set once, app-wide, from ../index.ts.

/** Chrome freezes the platform part of its User-Agent to one string per OS,
 * whatever the real OS version or CPU; these are those strings. */
const CHROME_PLATFORM_TOKENS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7'
}
const LINUX_PLATFORM_TOKEN = 'X11; Linux x86_64'

/** `chromeVersion` is `process.versions.chrome`. Only its major survives:
 * Chrome itself reports `<major>.0.0.0`, so a full build number would mark
 * this browser out as not-Chrome as surely as an `Electron/` token does. */
export function chromeUserAgent (chromeVersion: string, platform: NodeJS.Platform): string {
  const major = chromeVersion.split('.')[0] ?? '0'
  const platformToken = CHROME_PLATFORM_TOKENS[platform] ?? LINUX_PLATFORM_TOKEN
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}
