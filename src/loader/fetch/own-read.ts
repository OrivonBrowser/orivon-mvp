// The mark on a read the main process makes of a host a protocol serves, for its own purposes: installing or updating an
// app, a live-served app's file, an icon. The verifier's loopback server hands a request for a host the shell serves from
// a copy it keeps to the shell's handler for that host, and that handler may itself read the verifier; a read carrying
// this mark is the shell's own and is never handed back to it. A page cannot send the mark: it holds a secret chosen
// at random when this process started, which only the shell and the verifier host it starts are given.

import { OWN_READ_HEADER } from './content-root.js'
import { servedByVerifier } from './verifier-origin.js'

const TOKEN = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** The secret the verifier host compares the mark with. Handed to it in its configuration and nowhere else. */
export function ownReadToken (): string {
  return TOKEN
}

/**
 * `headers` for a read of `url`, with the mark added when `url` is a host the verifier serves and left as given for every
 * other host: the secret must reach no server but the verifier's own.
 */
export function asOwnRead (url: string, headers: Readonly<Record<string, string>> = {}): Record<string, string> {
  return servedByVerifier(url) ? { ...headers, [OWN_READ_HEADER]: TOKEN } : { ...headers }
}
