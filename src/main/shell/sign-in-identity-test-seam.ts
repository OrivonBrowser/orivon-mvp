// Test builds only: lets an e2e stand a local fixture server in for a real
// sign-in host, via ORIVON_TEST_SIGN_IN_HOSTS -- e.g.
// "127.0.0.1:54321" -- so the e2e suite can prove the header rewrite, the
// navigator.userAgent swap and the userAgentData hiding all fire, without
// ever addressing accounts.google.com itself. Gated on the same compiled-in
// flag as the developer grant (./dev/dev-grant.ts -- imported here as
// ../dev/dev-grant.ts), so an ordinary build carries none of it: an env var
// alone does nothing there, since the code that reads it does not exist in
// the bundle. scripts/check-dev-grant-absent.mjs proves that by looking for
// __orivonDevSignInTestSeam in the output.

import { SIGN_IN_HOSTS } from './sign-in-identity.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation. Set true the first time the seam actually supplies a
  // host, so an e2e assertion can confirm the seam it asked for was live,
  // not silently skipped.
  var __orivonDevSignInTestSeam: boolean | undefined
}

/** Pure parse, so the shape is unit-testable without a compiled-in flag or
 * a real environment: a comma-separated list of `host:port` (or bare host)
 * entries, or `[]` for an unset/empty variable. */
export function parseSignInTestHosts (raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** `[]` outside a test build (SEAM_ENABLED is a literal `false` there, so
 * this whole branch is dead code a production minifier removes -- the
 * absence, not just the inertness, is what scripts/check-dev-grant-
 * absent.mjs proves). Reads the real environment inside one. */
export function signInTestHosts (env: NodeJS.ProcessEnv = process.env): readonly string[] {
  if (!SEAM_ENABLED) return []
  const hosts = parseSignInTestHosts(env['ORIVON_TEST_SIGN_IN_HOSTS'])
  if (hosts.length > 0) globalThis.__orivonDevSignInTestSeam = true
  return hosts
}

/** The real hosts, plus whatever the test seam adds -- never fewer than
 * SIGN_IN_HOSTS, so an ordinary host outside both lists (a plain fixture
 * page a test also loads) is exactly as unaffected as in production. */
export function resolveSignInHosts (env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...SIGN_IN_HOSTS, ...signInTestHosts(env)]
}
