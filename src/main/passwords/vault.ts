// What the rest of the shell may ask of the saved-login store, and an
// in-memory store that keeps the contract. The encrypted store on disk is a
// second implementation of the same interface, chosen where the services are
// built, so a caller never names either. Pure: no `electron` import.
import { originFromUrl } from '../../broker/policy/origin.js'

/** A saved login as every caller but `reveal` sees it: never with its password. */
export interface Login {
  readonly id: string
  /** The origin it belongs to, `https://host` or `http://host:port`. */
  readonly origin: string
  readonly username: string
  readonly created: number
  /** When it was last filled, 0 if never. */
  readonly used: number
}

export interface LoginInput {
  readonly origin: string
  readonly username: string
  readonly password: string
}

/** `ready` keeps logins; `unavailable` means nothing can be stored safely on this computer; `private` is a private window, which keeps nothing. */
export type VaultState = 'ready' | 'unavailable' | 'private'

/** Origins the person said never to offer to save for. */
export interface NeverSaved {
  has: (origin: string) => boolean
  add: (origin: string) => void
  remove: (origin: string) => void
  list: () => readonly string[]
}

export interface PasswordVault {
  /** Where the store stands. A store that has to ask the system whether it can keep anything answers `unavailable` until `ready` resolves. */
  state: () => VaultState
  /** Resolves once `state` is final; absent on a store that knows at once. */
  ready?: () => Promise<void>
  /** Every login, or those of one origin; oldest first. Never carries a password. */
  list: (origin?: string) => readonly Login[]
  /** The password of one login, or undefined when there is none. Only the store's own pages call this. */
  reveal: (id: string) => Promise<string | undefined>
  /** Adds a login, or replaces the password of the one with the same origin and username. Null when it cannot be kept. */
  save: (entry: LoginInput) => Promise<Login | null>
  remove: (id: string) => boolean
  readonly never: NeverSaved
  onChange: (listener: () => void) => () => void
}

const MAX_LOGINS = 5000

/** Keeps logins for this process only. With a state other than `ready` it refuses every save, like a store that cannot write. */
export function memoryVault (state: VaultState = 'ready'): PasswordVault {
  const logins = new Map<string, { login: Login, password: string }>()
  const never = new Set<string>()
  const listeners = new Set<() => void>()
  let counter = 0
  const changed = (): void => { for (const listener of [...listeners]) listener() }
  return {
    state: () => state,
    list: (origin) => [...logins.values()].map((entry) => entry.login).filter((login) => origin === undefined || login.origin === origin),
    reveal: async (id) => await Promise.resolve(logins.get(id)?.password),
    save: async (entry) => {
      const valid = state === 'ready' && originFromUrl(entry.origin) === entry.origin && entry.password !== ''
      if (!valid) return await Promise.resolve(null)
      const existing = [...logins.values()].find(({ login }) => login.origin === entry.origin && login.username === entry.username)
      if (existing === undefined && logins.size >= MAX_LOGINS) return await Promise.resolve(null)
      const login: Login = existing?.login ?? { id: `memory-${String(++counter)}`, origin: entry.origin, username: entry.username, created: Date.now(), used: 0 }
      logins.set(login.id, { login, password: entry.password })
      changed()
      return await Promise.resolve(login)
    },
    remove: (id) => {
      const removed = logins.delete(id)
      if (removed) changed()
      return removed
    },
    never: {
      has: (origin) => never.has(origin),
      add: (origin) => { if (state === 'ready' && originFromUrl(origin) === origin && !never.has(origin)) { never.add(origin); changed() } },
      remove: (origin) => { if (never.delete(origin)) changed() },
      list: () => [...never]
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
