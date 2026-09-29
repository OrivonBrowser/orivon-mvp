// Test builds only: two overrides for the Chrome Web Store CRX install path
// -- the download URL (installFromStore(id) fetches from a local fixture
// server instead of the real store) and the publisher-key hash verifyCrx3
// checks against (a fixture CRX is signed by a test key, never Google's real
// one). Gated on the same compiled-in flag as the developer grant
// (../dev/dev-grant.ts), so an ordinary build carries neither: an env var
// alone does nothing there, since the code that reads it does not exist in
// the bundle. scripts/check-dev-grant-absent.mjs proves that by looking for
// __orivonDevStoreTestSeam in the output.

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation. Set true the first time either override below actually
  // fires, so an e2e assertion can confirm the seam it asked for was live,
  // not silently skipped.
  var __orivonDevStoreTestSeam: boolean | undefined
}

/** The real store's CRX download URL for `id`, unless
 * ORIVON_TEST_STORE_BASE_URL names a fixture server to use instead --
 * `<base>/<id>.crx`. */
export function storeCrxDownloadUrl (id: string): string {
  if (SEAM_ENABLED) {
    const base = process.env['ORIVON_TEST_STORE_BASE_URL']
    if (base !== undefined) {
      globalThis.__orivonDevStoreTestSeam = true
      return `${base}/${id}.crx`
    }
  }
  return `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2%2Ccrx3&x=id%3D${id}%26uc&prodversion=${process.versions.chrome}`
}

/** Overrides crx.ts's CHROME_WEB_STORE_PUBLISHER_KEY_HASH, so a fixture CRX
 * signed by a key this repository controls verifies as a "publisher" proof
 * -- undefined (crx.ts's own real hash applies) unless
 * ORIVON_TEST_STORE_PUBLISHER_KEY_HASH names one, hex-encoded. */
export function storeTestPublisherKeyHash (): Buffer | undefined {
  if (!SEAM_ENABLED) return undefined
  const hex = process.env['ORIVON_TEST_STORE_PUBLISHER_KEY_HASH']
  if (hex === undefined) return undefined
  globalThis.__orivonDevStoreTestSeam = true
  return Buffer.from(hex, 'hex')
}
