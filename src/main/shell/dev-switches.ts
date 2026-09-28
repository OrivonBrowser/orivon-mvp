// Command-line switches index.ts must append before app.whenReady(), beyond
// what verifierSubsystem's own beforeReady already adds -- split out so this
// decision is testable without mocking the whole 'electron' module (index.ts
// itself has side effects at import time, real or mocked, the moment it is
// imported at all).

import { devModeEnabled } from '../dev/dev-mode.js'

/**
 * `--disable-http-cache`, in developer mode only: turns off Chromium's disk
 * and memory HTTP cache for the whole session, so a `.eth` response's own
 * `cache-control: no-cache`/`ETag` revalidation (server.ts) can never reuse
 * an old cached body and headers across a `npm run dev` restart -- exactly
 * what would otherwise mask a code change to the verifier that touches
 * nothing about the site's own content. `npm start`, the real application,
 * is untouched: it keeps a real browser's caching, dev and start sharing the
 * same on-disk `userData` regardless.
 *
 * Nothing else needs resetting here: the verifier's in-memory mount and
 * block caches already start empty every process launch, and the light
 * client's checkpoint, the IPNS sequence floor and installed app bundles
 * under `userData` are state, not cache -- resetting those on every dev
 * restart would be a regression, not a fix.
 */
export function devOnlySwitches (): readonly string[] {
  return devModeEnabled() ? ['disable-http-cache'] : []
}
