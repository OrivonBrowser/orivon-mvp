// Reads an engine's answer to a typed prefix. Pure. The answer is text from a server, so it is never trusted to
// be shaped: anything that is not a string of a sane size is dropped, and what is kept is cleaned for a plain label.

export const MAX_SUGGESTIONS = 4
export const MAX_SUGGESTION_LENGTH = 200

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
/** Characters that reorder or hide the text around them, so a label could read as something it is not. */
const BIDI = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The strings an answer offers, in the order given, from the shapes engines use: OpenSearch
 * (`[query, [suggestion, ...]]`), a list of objects (`[{ phrase }]`), and a wrapped list (`{ data: { items: [{ value }] } }`). */
function candidates (parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    if (Array.isArray(parsed[1])) return parsed[1] as unknown[]
    return parsed.map((entry) => isRecord(entry) ? (entry['phrase'] ?? entry['value']) : entry)
  }
  if (isRecord(parsed) && isRecord(parsed['data']) && Array.isArray(parsed['data']['items'])) {
    return (parsed['data']['items'] as unknown[]).map((item) => isRecord(item) ? item['value'] : undefined)
  }
  return []
}

/** Up to four distinct suggestions other than the text itself. `typed` is what the person typed. */
export function parseSuggestions (body: string, typed: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const same = typed.trim().toLowerCase()
  const seen = new Set<string>([same])
  const found: string[] = []
  for (const candidate of candidates(parsed)) {
    if (typeof candidate !== 'string') continue
    const text = candidate.replace(BIDI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
    if (text === '' || text.length > MAX_SUGGESTION_LENGTH) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    found.push(text)
    if (found.length === MAX_SUGGESTIONS) break
  }
  return found
}
