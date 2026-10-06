// Header edits for the network privacy controls. Pure: no `electron` import.
// Every function returns the object it was given when it changes nothing, so
// the web-request owner can tell "no opinion" from "rewrite the headers"
// (web-request-owner.ts answers a bare `{}` for an unchanged result).

/** The key `headers` already holds for `name`, whatever its case. */
function keyOf (headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return Object.keys(headers).find((key) => key.toLowerCase() === wanted)
}

/** `headers` without any key spelled `name` in any case: a header sent twice under two spellings arrives as two keys. */
function withoutHeader<V> (headers: Record<string, V>, name: string): Record<string, V> {
  const wanted = name.toLowerCase()
  const spellings = Object.keys(headers).filter((key) => key.toLowerCase() === wanted)
  if (spellings.length === 0) return headers
  const next = { ...headers }
  for (const key of spellings) delete next[key]
  return next
}

/** `headers` with `name` set to `value`, replacing a differently-cased spelling of the same header. */
function withHeader (headers: Record<string, string>, name: string, value: string): Record<string, string> {
  const existing = keyOf(headers, name)
  if (existing === name && headers[existing] === value) return headers
  const next = { ...headers }
  if (existing !== undefined) delete next[existing]
  next[name] = value
  return next
}

/** Adds `DNT: 1` when asked; off leaves the request as it was. Global Privacy Control is not here: the engine sends it (`gpc-switch.ts`). */
export function withDoNotTrack (headers: Record<string, string>, on: boolean): Record<string, string> {
  return on ? withHeader(headers, 'DNT', '1') : headers
}

/** `headers` without the `Cookie` request header. */
export function withoutCookie (headers: Record<string, string>): Record<string, string> {
  return withoutHeader(headers, 'cookie')
}

/** A response's headers without `Set-Cookie`. */
export function withoutSetCookie (headers: Record<string, string[]>): Record<string, string[]> {
  return withoutHeader(headers, 'set-cookie')
}
