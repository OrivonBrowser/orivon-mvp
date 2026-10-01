// Test builds only: a local fixture stands in for an engine's suggestion service, through
// ORIVON_TEST_SUGGEST_URL (an http address on this computer, `%s` for the text), so the e2e suite never reaches
// a real engine. Gated on the compiled-in flag the developer grant uses, so an ordinary build carries none of it:
// scripts/check-dev-grant-absent.mjs looks for the variable's name in the output.

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** null outside a test build, where this whole branch is removed by the bundler. */
export function testSuggestEndpoint (env: NodeJS.ProcessEnv = process.env): string | null {
  if (!SEAM_ENABLED) return null
  const raw = env['ORIVON_TEST_SUGGEST_URL']
  return raw === undefined || raw === '' ? null : raw
}
