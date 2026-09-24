// Test builds only: the end-to-end suite's `.eth` fixture names, gateways
// and DNS-over-HTTPS endpoints, read from the environment. Gated on the
// same compiled-in flag as the developer grant (../dev/dev-grant.ts), so an
// ordinary build carries none of it; scripts/check-dev-grant-absent.mjs
// proves that by looking for __orivonDevEthFixtures in the output.

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

// `var`, not `let`/`const`: TypeScript requires it for a `declare global` augmentation.
declare global {
  var __orivonDevEthFixtures: Readonly<Record<string, string>> | undefined
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
  globalThis.__orivonDevEthFixtures = seam?.fixtures
  return seam
}
