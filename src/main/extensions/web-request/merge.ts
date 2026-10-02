// Combines what several extensions' blocking listeners answered for one
// request into the one answer Electron's session gets, by Chrome's rules:
// a cancel wins; a redirect or a header change from the most recently
// installed extension goes last, so it prevails where two disagree.
// Replies are untrusted data from an extension page: every shape is checked.

export interface Reply {
  readonly extensionId: string
  /** When the extension was installed; the newest wins a conflict. */
  readonly installedAt: number
  readonly response: unknown
}

function asRecord (value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Oldest install first, stable among one extension's listeners. */
function oldestFirst (replies: readonly Reply[]): Reply[] {
  return replies.map((reply, index) => ({ reply, index }))
    .sort((a, b) => a.reply.installedAt - b.reply.installedAt || a.index - b.index)
    .map((entry) => entry.reply)
}

const cancelled = (reply: Reply): boolean => asRecord(reply.response)?.cancel === true

/** Where a listener may send a request: the web, `data:`, a blank page, or a
 * page of its own extension. Nothing else (no `javascript:`, no other
 * extension, no `file:`). */
export function redirectAllowed (extensionId: string, redirectUrl: string): boolean {
  if (redirectUrl === 'about:blank') return true
  let url: URL
  try {
    url = new URL(redirectUrl)
  } catch {
    return false
  }
  if (['http:', 'https:', 'ws:', 'wss:', 'data:'].includes(url.protocol)) return true
  return url.protocol === 'chrome-extension:' && url.hostname === extensionId
}

export type BeforeRequestResult = { readonly cancel: true } | { readonly redirectUrl: string } | undefined

export function mergeBeforeRequest (replies: readonly Reply[]): BeforeRequestResult {
  if (replies.some(cancelled)) return { cancel: true }
  let redirectUrl: string | undefined
  for (const reply of oldestFirst(replies)) {
    const candidate = asRecord(reply.response)?.redirectUrl
    if (typeof candidate === 'string' && redirectAllowed(reply.extensionId, candidate)) redirectUrl = candidate
  }
  return redirectUrl === undefined ? undefined : { redirectUrl }
}

interface Pair {
  readonly name: string
  readonly value: string
}

const pairKey = (pair: Pair): string => `${pair.name.toLowerCase()}\u0000${pair.value}`

/** A reply's header list as pairs, or undefined when it is absent or any
 * entry is malformed (the whole list is then ignored, never half-applied). */
function parseHeaderList (raw: unknown): Pair[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const pairs: Pair[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (record === undefined || typeof record.name !== 'string' || record.name === '') return undefined
    if (typeof record.value === 'string') {
      pairs.push({ name: record.name, value: record.value })
    } else if (Array.isArray(record.binaryValue) && record.binaryValue.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      pairs.push({ name: record.name, value: String.fromCharCode(...(record.binaryValue as number[])) })
    } else {
      return undefined
    }
  }
  return pairs
}

/** Each listener answered with the complete list it wants; what it changed
 * is the difference from the original. Applying the differences one after
 * another, newest last, lets two extensions each change a different header
 * without the second undoing the first. `undefined`: nobody changed anything. */
function applyHeaderDeltas (original: readonly Pair[], replies: readonly Reply[], listKey: 'requestHeaders' | 'responseHeaders'): Pair[] | undefined {
  const originalKeys = new Set(original.map(pairKey))
  let current = [...original]
  let changed = false
  for (const reply of oldestFirst(replies)) {
    const proposed = parseHeaderList(asRecord(reply.response)?.[listKey])
    if (proposed === undefined) continue
    const proposedKeys = new Set(proposed.map(pairKey))
    const deleted = new Set([...originalKeys].filter((key) => !proposedKeys.has(key)))
    const added = proposed.filter((pair) => !originalKeys.has(pairKey(pair)))
    if (deleted.size === 0 && added.length === 0) continue
    changed = true
    // A header this reply dropped and wrote again is a replacement, so it also takes the place of a value an older install set.
    const deletedNames = new Set(original.filter((pair) => deleted.has(pairKey(pair))).map((pair) => pair.name.toLowerCase()))
    const replaced = new Set(added.map((pair) => pair.name.toLowerCase()).filter((name) => deletedNames.has(name)))
    current = current.filter((pair) => !deleted.has(pairKey(pair)) && !replaced.has(pair.name.toLowerCase()))
    for (const pair of added) {
      if (!current.some((held) => pairKey(held) === pairKey(pair))) current.push(pair)
    }
  }
  return changed ? current : undefined
}

function groupByName (pairs: readonly Pair[]): Map<string, { name: string, values: string[] }> {
  const groups = new Map<string, { name: string, values: string[] }>()
  for (const pair of pairs) {
    const key = pair.name.toLowerCase()
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { name: pair.name, values: [pair.value] })
    else group.values.push(pair.value)
  }
  return groups
}

export type RequestHeadersMerge = { readonly cancel: true } | { readonly requestHeaders: Record<string, string> } | undefined
export type ResponseHeadersMerge = { readonly cancel: true } | { readonly responseHeaders: Record<string, string[]> } | undefined

export function mergeRequestHeaders (original: Readonly<Record<string, string>>, replies: readonly Reply[]): RequestHeadersMerge {
  if (replies.some(cancelled)) return { cancel: true }
  const merged = applyHeaderDeltas(Object.entries(original).map(([name, value]) => ({ name, value })), replies, 'requestHeaders')
  if (merged === undefined) return undefined
  const requestHeaders: Record<string, string> = {}
  for (const { name, values } of groupByName(merged).values()) {
    requestHeaders[name] = values.join(name.toLowerCase() === 'cookie' ? '; ' : ', ')
  }
  return { requestHeaders }
}

export function mergeResponseHeaders (original: Readonly<Record<string, readonly string[]>>, replies: readonly Reply[]): ResponseHeadersMerge {
  if (replies.some(cancelled)) return { cancel: true }
  const merged = applyHeaderDeltas(Object.entries(original).flatMap(([name, values]) => values.map((value) => ({ name, value }))), replies, 'responseHeaders')
  if (merged === undefined) return undefined
  const responseHeaders: Record<string, string[]> = {}
  for (const { name, values } of groupByName(merged).values()) responseHeaders[name] = values
  return { responseHeaders }
}
