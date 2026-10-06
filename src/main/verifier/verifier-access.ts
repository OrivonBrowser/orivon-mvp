// How the rest of the shell asks for the verifier host without importing the file that holds it: an address bar that
// sees a name typed wakes it ahead of the request, and an embedded page's request waits for it. No `electron` import.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

export interface VerifierAccess {
  /** Starts the host if it is not running. */
  start: () => void
  /** Resolves once the host listens, reports it cannot serve, or the wait's bound passes. */
  ready: () => Promise<void>
  /** Whether the host can resolve this `.eth` name now: the light client can start, or the name is a developer or test-build one. Unset means no. */
  servesName?: (name: string) => boolean
}

let access: VerifierAccess = { start: () => {}, ready: async () => {} }

/** Set once by the verifier subsystem. */
export function provideVerifierAccess (provided: VerifierAccess): void {
  access = provided
}

/** Whether a `.eth` name would load in this run. False until the verifier subsystem says otherwise, so a feature that redirects to a name never sends a person where nothing loads. */
export function verifierServesName (name: string): boolean {
  return access.servesName?.(name) === true
}

/** Whether the text names a host the verifier serves: a `.eth` name or an address, typed with or without a scheme, port or path. */
export function namesVerifiedHost (text: string): boolean {
  const typed = text.trim()
  if (typed === '') return false
  if (BUILTIN_ADDRESSES.servedUrl(typed) !== undefined) return true
  const authority = (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed.replace(/^[^/]*\/\//, '') : typed).split(/[/?#]/, 1)[0] ?? ''
  const host = (authority.split('@').pop() ?? '').replace(/:\d*$/, '').toLowerCase()
  return !/\s/.test(host) && BUILTIN_ADDRESSES.routesToVerifier(host)
}

/** Called with whatever is typed in the address bar: the host starts while the person is still typing, not once they press Enter. */
export function prewarmVerifier (typed: string): void {
  if (namesVerifiedHost(typed)) access.start()
}

/** Waits for the host when `url` is one it serves; returns at once for any other. */
export async function holdForVerifier (url: string): Promise<void> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return
  }
  if (!BUILTIN_ADDRESSES.routesToVerifier(host)) return
  access.start()
  await access.ready()
}
