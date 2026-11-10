// Why the relay did not carry a host and port, as fixed words: the listener answers with a `RelayRefusal`, and the load-error
// sheet asks `reasonFor` what was noted for the host a failed `https:` load named, because a refused CONNECT reaches no web
// contents. A word and a sentence name no site, address or proxy. Pure: no `electron`.

import { FrontRefusal } from '../front.js'

/** What stopped a connection, in the words `orivon://report` counts. */
export type RefusalWord =
  /** The DNS provider has no address for the name. */
  | 'not-found'
  /** The DNS provider could not be asked through the proxy, or did not answer. */
  | 'no-answer'
  /** The proxy asks for a sign-in, which Orivon does not pass on. */
  | 'sign-in'
  /** The relay or the proxy will not carry this host. */
  | 'refused'
  /** The proxy could not be reached, or could not reach the address. */
  | 'unreachable'
  /** Every address of the name means the proxy's own machine. */
  | 'inside'
  /** The system's proxy is on a port an anonymity network uses. */
  | 'anonymity'
  /** Orivon could not tell which proxy the system names for this connection. */
  | 'unsure'

/** How long a failure is remembered for the sheet. */
export const FAILURE_MEMORY_MS = 30_000
export const MAX_REMEMBERED = 256

export interface RelayFailures {
  note: (host: string, port: number, word: RefusalWord) => void
  /** The word noted for `host` and `port` in the last half minute. */
  reasonFor: (host: string, port: number) => RefusalWord | undefined
}

const keyOf = (host: string, port: number): string => `${host.toLowerCase().replace(/\.$/, '')}:${String(port)}`

export function createRelayFailures (now: () => number = Date.now): RelayFailures {
  const seen = new Map<string, { readonly word: RefusalWord, readonly at: number }>()
  return {
    note: (host, port, word) => {
      const key = keyOf(host, port)
      seen.delete(key)
      seen.set(key, { word, at: now() })
      while (seen.size > MAX_REMEMBERED) seen.delete(seen.keys().next().value as string)
    },
    reasonFor: (host, port) => {
      const entry = seen.get(keyOf(host, port))
      return entry !== undefined && now() - entry.at < FAILURE_MEMORY_MS ? entry.word : undefined
    }
  }
}

const SWITCH = '\'Look up site addresses in Orivon\''
const UNDO = 'turn this off in Settings, Privacy and network'

/** What a person is told for `word`. `provider` is the Secure DNS provider in use. */
export function refusalSentence (word: RefusalWord, provider = 'your Secure DNS provider'): string {
  switch (word) {
    case 'not-found':
      return `Orivon could not find this site's address. While ${SWITCH} is on, names are looked up through your proxy with ${provider}, never by your proxy or by this computer's DNS, so names only your company's network knows, such as its internal sites, do not open. Add them to your system's proxy exceptions, or ${UNDO}.`
    case 'no-answer':
      return `Orivon could not reach ${provider} through your proxy to find this site's address, and it never asks this computer's DNS while ${SWITCH} is on. Check that your proxy lets ${provider} through, choose another Secure DNS provider, or ${UNDO}.`
    case 'sign-in':
      return `Your proxy asks for a sign-in, which Orivon does not pass on while ${SWITCH} is on. You can ${UNDO}.`
    case 'refused':
      return `Orivon, or your proxy, would not carry this connection while ${SWITCH} is on. Nothing was sent outside the proxy. You can ${UNDO}.`
    case 'unreachable':
      return `Your proxy could not be reached, or could not reach this site, while ${SWITCH} is on. Nothing was sent outside the proxy.`
    case 'inside':
      return `This site's address means your proxy's own computer, so Orivon did not ask the proxy to connect to it.`
    case 'anonymity':
      return `Your system's proxy looks like an anonymity network. Looking every name up through one connection to one DNS provider could link your visits, so Orivon does not do it while ${SWITCH} is on. You can ${UNDO}.`
    case 'unsure':
      return `Orivon could not tell which proxy your system uses for this site, so it sent nothing. Try again, or ${UNDO}.`
  }
}

type RefusalStatus = ConstructorParameters<typeof FrontRefusal>[0]

/** A listener refusal that says why in a word, for the sheet, the report and a wrapper that counts. */
export class RelayRefusal extends FrontRefusal {
  readonly word: RefusalWord
  /** `status` is 403 for a host that is not carried at all, else 502; `reason` defaults to the word's sentence. */
  constructor (word: RefusalWord, status?: RefusalStatus, reason?: string) {
    super(status ?? (word === 'refused' || word === 'anonymity' ? 403 : 502), reason ?? refusalSentence(word))
    this.word = word
  }
}
