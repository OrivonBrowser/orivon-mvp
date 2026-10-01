// When a submitted sign-in is worth offering to keep. A submission alone proves nothing: the password may
// be wrong. So the offer waits for what the tab does next and judges it: a page that took the person on and
// no longer asks for a password says it worked; one that answered with an error, asks again, or belongs to
// another site says it did not. Pure: no `electron` import, time comes in as an argument.
import type { Login, PasswordVault } from './vault.js'

/** How long after the submit a navigation or a vanished password field still counts as its result. */
export const SUCCESS_WINDOW_MS = 10_000
/** A page that never navigates shows it worked only by losing its password field; give it this long to settle. */
export const QUIET_MS = 2_500
/** How long a credential is kept for the password button after the prompt went away. */
export const KEEP_MS = 5 * 60_000

/** A credential the page submitted and the person has not decided on. Held in memory only. */
export interface PendingCredential {
  readonly origin: string
  readonly username: string
  readonly password: string
  readonly at: number
}

/** A main-frame navigation of the tab. `status` is the HTTP status, or -1 when the navigation had none. */
export interface Navigation { readonly at: number, readonly inPage: boolean, readonly status: number, readonly origin: string | null }

/** What the tab has shown since: its navigations, and the last word of its form watcher about password fields. */
export interface Observed {
  readonly navigations: readonly Navigation[]
  readonly fields: { readonly hasPassword: boolean, readonly at: number } | null
}

export type Verdict = 'wait' | 'offer' | 'drop'

/**
 * Whether the pending credential is worth offering now. `wait` means ask again after the next event or
 * timer; `drop` means forget it. The caller calls this after each navigation and field report, and at
 * QUIET_MS and SUCCESS_WINDOW_MS after the submit.
 */
export function judge (pending: PendingCredential, observed: Observed, now: number): Verdict {
  const age = now - pending.at
  if (age > KEEP_MS) return 'drop'
  const navigations = observed.navigations.filter((navigation) => navigation.at >= pending.at)
  if (navigations.some((navigation) => !navigation.inPage && navigation.status >= 400)) return 'drop'
  // The sign-in took the tab to another site: the credential belongs to the one it left.
  if (navigations.some((navigation) => navigation.origin !== pending.origin)) return 'drop'

  const full = navigations.filter((navigation) => !navigation.inPage).at(-1)
  const inPage = navigations.some((navigation) => navigation.inPage)
  // A field report made before the page that follows the submit says nothing about it.
  const since = full?.at ?? pending.at
  const fields = observed.fields !== null && observed.fields.at >= since ? observed.fields.hasPassword : null

  if (full !== undefined) {
    if (fields === true) return 'drop'
    if (fields === false) return 'offer'
    return age > SUCCESS_WINDOW_MS ? 'drop' : 'wait'
  }
  if (fields === false && (inPage || age >= QUIET_MS)) return 'offer'
  return age > SUCCESS_WINDOW_MS ? 'drop' : 'wait'
}

export type OfferKind = 'save' | 'update' | 'none'

/** What offering this credential would do: add a login, change the password of one, or nothing because it is already kept. */
export async function classify (vault: Pick<PasswordVault, 'list' | 'reveal'>, pending: Pick<PendingCredential, 'origin' | 'username' | 'password'>): Promise<{ kind: OfferKind, login?: Login }> {
  const existing = vault.list(pending.origin).find((login) => login.username === pending.username)
  if (existing === undefined) return { kind: 'save' }
  const kept = await vault.reveal(existing.id)
  return kept === pending.password ? { kind: 'none', login: existing } : { kind: 'update', login: existing }
}
