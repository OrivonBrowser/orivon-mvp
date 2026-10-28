// The text of an address that holds a key must never reach the log, a report or a screen. The places that learn such a key
// (the Ethereum servers the person typed in Settings) note it here when they read it; every line that is logged and every
// report body is then scrubbed of it. A secret is remembered for the whole run, so a key the person has since removed is
// still kept out of a line printed later. A line printed before the key was read is not scrubbed, so the one reader that
// logs before it (the settings store, which reads the file first) never quotes the file's text. Pure: no I/O.

import { MASK } from '../../protocols/verifier-host/light-client/endpoint-mask.js'

/** A shorter string is a word, not a key, and would blank ordinary text. */
const MIN_SECRET_LENGTH = 4
/** The most secrets held: a person changes a handful of addresses a session; the one noted longest ago goes when a flood would otherwise grow this without bound. */
const MAX_SECRETS = 256

interface Note {
  readonly secret: string
  readonly shown: string
}

/** In the order last noted, so the one noted longest ago is the one dropped. */
let byAge: Note[] = []
/** The same, longest first, so an address is replaced whole before the key inside it is looked for. */
let notes: Note[] = []

export function noteSecret (secret: string, shown: string = MASK): void {
  if (secret.length < MIN_SECRET_LENGTH) return
  // Noted again, a secret becomes the newest: one still in use is not the one dropped when a flood of others follows it.
  byAge = [...byAge.filter((note) => note.secret !== secret), { secret, shown }].slice(-MAX_SECRETS)
  notes = [...byAge].sort((a, b) => b.secret.length - a.secret.length)
}

/** `text` with every noted secret replaced. */
export function scrub (text: string): string {
  if (notes.length === 0) return text
  let out = text
  for (const { secret, shown } of notes) if (out.includes(secret)) out = out.split(secret).join(shown)
  return out
}

/** `value` with `scrub` applied to every string inside it, arrays and objects included. The value itself when nothing is noted. */
export function scrubDeep<T> (value: T): T {
  if (notes.length === 0) return value
  if (typeof value === 'string') return scrub(value) as T
  if (Array.isArray(value)) return value.map((entry) => scrubDeep(entry as unknown)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDeep(entry as unknown)])) as T
  }
  return value
}

/** Tests only: the run's secrets are never forgotten otherwise. */
export function forgetSecrets (): void {
  byAge = []
  notes = []
}
