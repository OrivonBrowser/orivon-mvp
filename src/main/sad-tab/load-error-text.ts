// What the sheet over a page that failed to load says, as a fixed table by Chromium's network error code. The only
// other text on it is the tab's own address and the error's short name, which is checked to be one.

import type { LoadRefusal } from '../route/load-refusals.js'
import { PLAIN_NAME_REFUSED, PROXY_NOT_KNOWN, PROXY_REFUSAL_ADVICE, PROXY_WOULD_SEE_NAME } from '../route/verifier-name-guard.js'

export interface LoadErrorText {
  readonly title: string
  readonly body: string
}

const UNREACHABLE = 'This site can\'t be reached'
const NOT_WORKING = 'This page isn\'t working'
const NOT_SECURE = 'This site can\'t make a secure connection'

const NO_SUCH_NAME: LoadErrorText = { title: UNREACHABLE, body: 'No server answers to this name. Check the address for a typing mistake.' }
const TOO_SLOW: LoadErrorText = { title: UNREACHABLE, body: 'The server took too long to answer.' }
const NOT_CARRIED: LoadErrorText = { title: UNREACHABLE, body: 'The tunnel did not carry this page, and nothing was sent outside it. Open Settings, then Tunnels, to see why it is not working.' }
const CLOSED: LoadErrorText = { title: UNREACHABLE, body: 'The connection was closed before the page arrived.' }

/** Chromium's `net::ERR_*` codes a person meets, by number. Certificate failures are not here: they have their own sheet. */
const BY_CODE: ReadonlyMap<number, LoadErrorText> = new Map([
  [-6, { title: 'File not found', body: 'There is no file at this address.' }],
  [-7, TOO_SLOW],
  [-10, { title: 'Access denied', body: 'Orivon is not allowed to read this file.' }],
  [-20, { title: 'This page was blocked', body: 'An extension or a content filter stopped this page from loading.' }],
  [-21, { title: 'The network changed', body: 'The connection was interrupted by a change of network.' }],
  [-100, CLOSED],
  [-101, { title: UNREACHABLE, body: 'The connection was reset.' }],
  [-102, { title: UNREACHABLE, body: 'The server refused the connection.' }],
  [-104, { title: UNREACHABLE, body: 'The connection to the server failed.' }],
  [-105, NO_SUCH_NAME],
  [-106, { title: 'You are offline', body: 'This computer is not connected to the internet.' }],
  [-107, { title: NOT_SECURE, body: 'The server answered in a way a secure connection does not allow.' }],
  [-109, { title: UNREACHABLE, body: 'The server\'s address cannot be reached from this network.' }],
  [-111, NOT_CARRIED],
  [-113, { title: NOT_SECURE, body: 'The server only offers a secure connection that is no longer safe to use.' }],
  [-118, TOO_SLOW],
  [-130, NOT_CARRIED],
  [-137, NO_SUCH_NAME],
  [-300, { title: 'This address is not valid', body: 'Check the address for a typing mistake.' }],
  [-310, { title: NOT_WORKING, body: 'It redirected too many times. Deleting this site\'s cookies may help.' }],
  [-320, { title: NOT_WORKING, body: 'The server sent an answer Orivon cannot read.' }],
  [-324, { title: NOT_WORKING, body: 'The server sent no data.' }]
])

const ONION_NEEDS_TOR: LoadErrorText = { title: UNREACHABLE, body: 'An onion address can be reached only through a Tor tunnel, so it was not looked up. To open it, set Tor\'s SOCKS5 address in Settings, then Tunnels, and send this site through it.' }

const NAME_NOT_OPENED: LoadErrorText = { title: 'This name was not opened', body: `${PROXY_WOULD_SEE_NAME} ${PROXY_REFUSAL_ADVICE}` }
const NAME_NOT_KNOWN: LoadErrorText = { title: 'This name was not opened', body: `${PROXY_NOT_KNOWN} Trying again may help. ${PROXY_REFUSAL_ADVICE}` }
const NAME_NOT_PLAIN: LoadErrorText = { title: 'This name opens only over https', body: PLAIN_NAME_REFUSED }

const DEFAULT_TEXT: LoadErrorText = { title: 'This page couldn\'t be loaded', body: 'Something went wrong while loading it. Trying again may help.' }

/** Whether `value` is one of the reasons Orivon cancels a load before sending it (`../route/load-refusals.ts`). */
export function isLoadRefusal (value: unknown): value is LoadRefusal {
  return value === 'onion' || value === 'would-see' || value === 'unsure' || value === 'plain'
}

const BY_REFUSAL: Readonly<Record<LoadRefusal, LoadErrorText>> = { onion: ONION_NEEDS_TOR, 'would-see': NAME_NOT_OPENED, unsure: NAME_NOT_KNOWN, plain: NAME_NOT_PLAIN }

/** `refusal`: why Orivon cancelled the load before anything was sent, when it did; the sheet then says that instead of naming an extension. */
export function loadErrorText (code: number, refusal?: LoadRefusal): LoadErrorText {
  if (refusal !== undefined) return BY_REFUSAL[refusal]
  return BY_CODE.get(code) ?? DEFAULT_TEXT
}

/** Chromium's short name for an error, as Electron reports it: shown on the sheet so a person can look it up. */
export function isErrorName (value: unknown): value is string {
  return typeof value === 'string' && /^ERR_[A-Z0-9_]{1,60}$/.test(value)
}
