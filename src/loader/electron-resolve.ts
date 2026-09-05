// A real Resolver (policy/connect.ts's own injected-dependency shape) over
// Electron's net.resolveHost -- Chromium's OWN resolver, the SAME one
// electron-fetch.ts's net.fetch call actually consults to connect (both run
// under the default session: net.fetch never specifies one, and
// net.resolveHost's own doc says it resolves "using the default session").
//
// WHY THIS, NOT node-adapters.ts's resolveHost (F2). That function is
// node:dns/promises-based -- correct for the BROKER's outbound tcp.connect,
// which dials with real node:net sockets (also node:dns-resolved, so guard
// and dial agree there). The loader's install-origin guard is checking
// something different: what a Chromium-mediated fetch will do. Backing the
// guard with node:dns instead of Chromium's own resolver was exactly install-
// origin.ts's original F2 defect restated one level down -- a correct guard
// answering a question the real request never asks. This resolver and
// electron-fetch.ts's own immediate pre-fetch re-check (see its comment) now
// both go through the identical resolver/cache; the two Resolver
// implementations differ because the two things they validate genuinely
// differ (a raw socket dial vs. what a browser-grade fetch does), not because
// Rule 3 was skipped -- see docs/development/code-guidelines.md Rule 3's own
// "extract when the reason is shared, not when the shape is".

import type { Resolver } from '../broker/policy/connect.js'

export const electronResolveHost: Resolver = async (host) => {
  // Dynamically imported: outside a real Electron process (i.e. under
  // vitest), `electron`'s entry point is a path STRING, and a top-level
  // import would silently bind `undefined` rather than throw -- same
  // reasoning as electron-fetch.ts.
  const { net } = await import('electron')
  const resolved = await net.resolveHost(host)
  return resolved.endpoints.map((endpoint) => endpoint.address)
}
