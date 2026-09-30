// The extensions disclosure's one line of consent copy, split out of
// ./grant-prompt-render.ts (docs/development/code-guidelines.md Rule 2), the
// way ./grant-prompt-embed.ts holds `web.embed`'s wording. Pure and I/O-free,
// like that file: the names are resolved by the caller (README.md's Design
// notes), never here.

/** The extensions disclosure (docs/planning/extensions-exploration.md, "disclose
 * where it matters"; ADR-0045's residual: an extension with host access to
 * a page can put code in its main world, indistinguishable from the
 * page's own). At most three names, then a count -- the same "first few,
 * then how many more" shape `../../broker/policy/extension-manifest.js`'s
 * own `describeHostAccess` already uses for a single extension's own host
 * list, applied here to the extensions themselves. Undefined for an empty
 * list, never an empty sentence. */
const MAX_LISTED_EXTENSIONS = 3

export function extensionsOnSiteLine (names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined
  const shown = names.slice(0, MAX_LISTED_EXTENSIONS)
  const rest = names.length - shown.length
  const list = `${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
  return `Extensions that can also act on this site: ${list}. Orivon keeps their code from using what you grant here, but they can change what the site shows and sends.`
}
