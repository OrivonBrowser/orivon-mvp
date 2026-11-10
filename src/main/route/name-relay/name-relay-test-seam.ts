// Test builds only: the address of the DNS-over-HTTPS server the relay's lookups go to, named by ORIVON_TEST_NAME_RELAY_DOH_URL,
// so an end-to-end test can answer them from a fake server behind its logging proxy and none reaches a real provider. Gated on
// the same compiled-in flag as the developer grant (../../dev/dev-grant.ts), so an ordinary build carries none of it, which
// scripts/check-dev-grant-absent.mjs proves by looking for the variable's name in the output.

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** The `https:` address a suite asked the lookups to use for every provider, or undefined for the provider's own. */
export function dohUrlOverride (env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const value = SEAM_ENABLED ? env['ORIVON_TEST_NAME_RELAY_DOH_URL'] : undefined
  if (value === undefined) return undefined
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}
