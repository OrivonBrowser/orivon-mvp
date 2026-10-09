// Test builds only: the end-to-end suite's `.eth` fixture names, gateways
// and DNS-over-HTTPS endpoints, read from the environment. Gated on the
// same compiled-in flag as the developer grant (../dev/dev-grant.ts), so an
// ordinary build carries none of it; scripts/check-dev-grant-absent.mjs
// proves that by looking for __orivonDevEthFixtures in the output.

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

// `var`, not `let`/`const`: TypeScript requires it for a `declare global` augmentation.
declare global {
  var __orivonDevEthFixtures: { readonly fixtures: Readonly<Record<string, string>>, listening: boolean, start?: () => void } | undefined
}

export interface EthTestSeam {
  readonly fixtures: Readonly<Record<string, string>>
  readonly gateways: readonly string[] | undefined
  readonly dnsOverHttps: readonly string[] | undefined
}

function list (value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((item) => item.trim()).filter((item) => item !== '')
  return items === undefined || items.length === 0 ? undefined : items
}

/** Throws on a malformed fixture map: a test naming content it cannot load must fail loudly. */
export function parseEthTestSeam (env: Readonly<Record<string, string | undefined>>): EthTestSeam | undefined {
  const raw = env['ORIVON_TEST_ETH_FIXTURES']
  if (raw === undefined) return undefined
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) {
    throw new Error('ORIVON_TEST_ETH_FIXTURES must be a JSON object of "name.eth": "ipfs://..."')
  }
  return { fixtures: parsed as Record<string, string>, gateways: list(env['ORIVON_TEST_IPFS_GATEWAYS']), dnsOverHttps: list(env['ORIVON_TEST_DOH']) }
}

export function ethTestSeam (): EthTestSeam | undefined {
  if (!SEAM_ENABLED) return undefined
  const seam = parseEthTestSeam(process.env)
  if (seam !== undefined) globalThis.__orivonDevEthFixtures ??= { fixtures: seam.fixtures, listening: false }
  return seam
}

/** Test builds only: lets a suite start the verifier host before it opens an address, since an ordinary launch starts it only when something needs it. */
export function exposeVerifierStart (start: () => void): void {
  if (!SEAM_ENABLED || ethTestSeam() === undefined || globalThis.__orivonDevEthFixtures === undefined) return
  globalThis.__orivonDevEthFixtures.start = start
}

/** Lets a test build's suite see when the verifier can answer, rather than guess with a delay. */
export function noteVerifierListening (listening: boolean): void {
  if (!SEAM_ENABLED || globalThis.__orivonDevEthFixtures === undefined) return
  globalThis.__orivonDevEthFixtures.listening = listening
}

/** Test builds only: how long the verifier host's start is held, so a suite can open an address before the host listens. Zero in an ordinary build. */
export function verifierStartDelayMs (): number {
  if (!SEAM_ENABLED) return 0
  const delay = Number(process.env['ORIVON_TEST_VERIFIER_START_DELAY_MS'])
  return Number.isFinite(delay) && delay > 0 ? delay : 0
}

/** The interval a suite asked for between looks at the apps open in tabs, or undefined for the ordinary one. */
export function parseUpdateWatchMs (env: Readonly<Record<string, string | undefined>>): number | undefined {
  const every = Number(env['ORIVON_TEST_UPDATE_WATCH_MS'])
  return Number.isFinite(every) && every >= 100 ? every : undefined
}

/** Test builds only: how often the apps open in tabs are looked at again; undefined in an ordinary build. */
export function updateWatchMs (): number | undefined {
  return SEAM_ENABLED ? parseUpdateWatchMs(process.env) : undefined
}

export function parseBackgroundPinDelayMs (env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env['ORIVON_TEST_BACKGROUND_PIN_DELAY_MS']
  if (raw === undefined || raw.trim() === '') return undefined
  const delay = Number(raw)
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined
}

/** Test builds only: how long after an app's tab is let in its whole bundle waits to download, so a suite can look at the page before the rest arrives; undefined in an ordinary build. */
export function backgroundPinDelayMs (): number | undefined {
  return SEAM_ENABLED ? parseBackgroundPinDelayMs(process.env) : undefined
}
