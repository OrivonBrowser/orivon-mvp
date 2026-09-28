// `capabilities.web.embed` (ADR-0039), split out of ./capabilities.ts
// (docs/development/code-guidelines.md Rule 2) as the manifest's own
// per-capability seam. Same stance as manifest.ts: THE INPUT IS ADVERSARIAL,
// every check REJECTS rather than repairs, and every rejection reason is
// developer-facing.

import type { EmbedCapability } from '../../contracts/index.js'
import { ANY_SITE, embedOriginRejection } from '../../broker/policy/embed-origin.js'
import { describeValue, extraKey, isRecord, optionalStringArray, reject } from './manifest.js'

/** The parity guard (scripts/check-manifest-parity.mjs) reads this list against the contract's `EmbedCapability`. */
const EMBED_CAPABILITY_KEYS = ['origins']
const MAX_PATTERNS = 256

/**
 * ADR-0039's `web.embed.origins` grammar: `"*"` alone, or exact
 * `http(s)://host[:port]` origins. The GRAMMAR is `embedOriginRejection`
 * (`../../broker/policy/embed-origin.js`), shared with the shell's own
 * runtime gate; this function owns only the developer-facing MESSAGE per
 * reason, the same split `validateWebContextOrigin` above makes.
 */
function validateEmbedOrigin (pattern: string, field: string): void {
  const rejection = embedOriginRejection(pattern)
  if (rejection === null) return
  switch (rejection) {
    case 'unparseable':
      reject(`${field} is neither "*" nor a valid URL: ${describeValue(pattern)}`)
      break
    case 'not-http':
      reject(`${field} must be an http or https origin, or "*": ${describeValue(pattern)}`)
      break
    case 'wildcard-host':
      reject(`${field} must be an EXACT origin or the bare "*" -- no wildcard host is accepted: ${describeValue(pattern)}`)
      break
    case 'userinfo':
      reject(`${field} must carry no userinfo: ${describeValue(pattern)}`)
      break
    case 'query-or-fragment':
      reject(`${field} must carry no query or fragment: ${describeValue(pattern)}`)
      break
    case 'path':
      reject(`${field} must carry no path beyond the bare origin: ${describeValue(pattern)}`)
      break
    case 'not-canonical':
      reject(
        `${field} is not written in its own canonical origin form -- write it exactly as its ` +
        `own \`new URL(...).origin\` (capability-api.ts's EmbedCapability.origins): ${describeValue(pattern)}`
      )
      break
  }
}

/**
 * `origins` is required, never empty, and `"*"` stands alone: a list that
 * names `"*"` beside an exact origin would be shown to a person as two
 * things and mean only one.
 */
export function readEmbed (raw: unknown, path: string): EmbedCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, EMBED_CAPABILITY_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const origins = optionalStringArray(raw, path, 'origins', MAX_PATTERNS, (pattern, i) => {
    validateEmbedOrigin(pattern, `${path}.origins[${i}]`)
  })
  if (origins === undefined) reject(`${path}.origins is required: an exact origin, or "*" for any site`)
  if (origins.length > 1 && origins.includes(ANY_SITE)) {
    reject(`${path}.origins: "*" already names every site, so it must be the only entry`)
  }
  return { origins }
}
