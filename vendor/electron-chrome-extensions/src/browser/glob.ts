// Orivon: no dependency on electron, so the router, the API helpers and a unit test can all import it.

/**
 * Linear-time match of one Chrome-style glob (`*` = any run of characters,
 * everything else literal -- the only operator `sandbox.pages` grammar
 * has) against `text`. Orivon patch (UPSTREAM.md patch 39): replaces a
 * regex built from `pattern.split('*').map(escapeRegExp).join('.*')` --
 * correct, but a pattern with several `*`s is a backtracking regex built
 * from the extension's OWN manifest and run on every page load and every
 * crx-msg, on the main thread: a pathological pattern
 * (`'a*a*a*a*a*a*a*a*a*a*a*a*a*a*!'`) against a long, almost-matching
 * string is the textbook catastrophic-backtracking shape. This never
 * builds a regex at all: split on `*`, then `indexOf` each literal piece
 * in order, anchoring the first piece to the start and the last to the
 * end -- O(pattern length + text length) however many stars the pattern
 * has.
 */
export function matchesGlob (pattern: string, text: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === text

  const first = parts[0] ?? ''
  if (!text.startsWith(first)) return false
  const last = parts[parts.length - 1] ?? ''
  if (!text.endsWith(last)) return false

  let pos = first.length
  const end = text.length - last.length
  if (pos > end) return false // not even room for the two anchors, let alone anything between

  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i] ?? ''
    if (piece.length === 0) continue // adjacent '**', or a '*' beside another
    const found = text.indexOf(piece, pos)
    if (found === -1 || found > end) return false
    pos = found + piece.length
  }
  return pos <= end
}
