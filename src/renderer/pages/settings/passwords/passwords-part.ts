// What the Passwords section knows: the list main reported, what the person has typed, which button waits for its
// second click, which password is on show. It asks main and never touches the page; ./passwords-view.ts draws it.
// A password lives here only while it is shown, and is forgotten when it is hidden.
import type { OrivonInternal } from '../../shared/bridge.js'
import { armEnded } from '../../shared/armed.js'
import { coalesce } from '../../shared/coalesce.js'
import type { SettingsPart } from '../settings-parts.js'
import { filterLogins, sortLogins, transferNotice, visibleEntries } from './passwords-model.js'
import type { ListEntry, LoginRow, Notice, TransferOutcome, VaultState } from './passwords-model.js'

/** A second click after this long starts over. */
export const ARM_MS = 4000
const TOAST_MS = 2000

interface ListReply {
  readonly state: VaultState
  readonly logins: readonly LoginRow[]
  readonly never: readonly string[]
  readonly hideMs: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function isListReply (value: unknown): value is ListReply {
  return isRecord(value) && typeof value['state'] === 'string' && Array.isArray(value['logins']) && Array.isArray(value['never']) && typeof value['hideMs'] === 'number'
}

export class PasswordsPart implements SettingsPart {
  /** Null until main has answered. */
  vault: VaultState | null = null
  logins: readonly LoginRow[] = []
  never: readonly string[] = []
  query = ''
  showAll = false
  toolsOpen = false
  notice: Notice | null = null
  /** What to say for a moment, and in which block: the list or the generator. */
  toast: { readonly text: string, readonly where: 'list' | 'generated' } | null = null
  generated: string | null = null
  /** The password on show, and the login it belongs to. */
  revealed: { readonly id: string, readonly password: string } | null = null
  /** The buttons that have had their first click, by login. */
  armedReveal: string | null = null
  armedDelete: string | null = null
  armedExport = false
  private hideMs = 30_000
  private readonly listeners = new Set<() => void>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reload: () => void

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {
    this.reload = coalesce(() => { void this.load().then(() => { this.changed() }) })
  }

  async load (): Promise<void> {
    const reply = await this.bridge.request('passwords', { type: 'list' })
    if (!isListReply(reply)) return
    this.vault = reply.state
    this.logins = reply.logins
    this.never = reply.never
    this.hideMs = reply.hideMs
    if (this.revealed !== null && !reply.logins.some((login) => login.id === this.revealed?.id)) this.hide(false)
  }

  handle (topic: string): boolean {
    if (topic !== 'passwords.changed') return false
    this.reload()
    return true
  }

  /** The view redraws itself on this; the page redraws on `notify`, which a change to the section's other rows needs. */
  subscribe (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Every login that matches the search, in order. */
  entries (): ListEntry[] {
    return filterLogins(sortLogins(this.logins), this.query)
  }

  page (): { readonly shown: readonly ListEntry[], readonly hidden: number, readonly matching: number } {
    const entries = this.entries()
    return { ...visibleEntries(entries, this.showAll), matching: entries.length }
  }

  setQuery (query: string): void {
    this.query = query
    this.showAll = false
    this.local()
  }

  showEverything (): void {
    this.showAll = true
    this.local()
  }

  toggleTools (): void {
    this.toolsOpen = !this.toolsOpen
    this.disarmExport()
    this.local()
  }

  dismissNotice (): void {
    this.notice = null
    this.local()
  }

  /** First click arms, the second shows, a click while shown hides. */
  pressReveal (id: string): void {
    if (this.revealed?.id === id) { this.hide(); return }
    if (this.armedReveal !== id) {
      this.armedReveal = id
      this.after('reveal', ARM_MS, () => { this.armedReveal = null; this.local() })
      this.local()
      return
    }
    this.clearTimer('reveal')
    this.armedReveal = null
    void this.show(id)
  }

  private async show (id: string): Promise<void> {
    const reply = await this.bridge.request('passwords', { type: 'reveal', id })
    const password = isRecord(reply) ? reply['password'] : undefined
    if (typeof password !== 'string') { this.local(); return }
    this.revealed = { id, password }
    this.after('hide', this.hideMs, () => { this.hide() })
    this.local()
  }

  /** Forgets the password on show. */
  hide (redraw = true): void {
    this.clearTimer('hide')
    if (this.revealed === null) return
    this.revealed = null
    if (redraw) this.local()
  }

  async copy (id: string): Promise<void> {
    const reply = await this.bridge.request('passwords', { type: 'copy', id })
    if (isRecord(reply) && reply['ok'] === true) this.say('Password copied', 'list')
  }

  /** First click arms, the second removes the login. */
  async pressDelete (id: string): Promise<void> {
    if (this.armedDelete !== id) {
      this.armedDelete = id
      this.after('delete', ARM_MS, () => { this.armedDelete = null; this.local(); armEnded() })
      this.local()
      return
    }
    this.clearTimer('delete')
    this.armedDelete = null
    if (this.revealed?.id === id) this.hide(false)
    await this.bridge.request('passwords', { type: 'remove', id })
    await this.load()
    this.changed()
    armEnded()
  }

  async removeNever (origin: string): Promise<void> {
    await this.bridge.request('passwords', { type: 'neverRemove', origin })
    await this.load()
    this.changed()
  }

  async generate (): Promise<void> {
    const reply = await this.bridge.request('passwords', { type: 'generate' })
    const password = isRecord(reply) ? reply['password'] : undefined
    if (typeof password !== 'string') return
    this.generated = password
    this.changed()
  }

  async copyGenerated (): Promise<void> {
    const reply = await this.bridge.request('passwords', { type: 'copyGenerated' })
    if (isRecord(reply) && reply['ok'] === true) this.say('Password copied', 'generated')
  }

  async importFile (): Promise<void> {
    this.notice = null
    this.finishTransfer(await this.bridge.request('passwords', { type: 'import' }))
  }

  /** First click arms, the second opens the save dialog. */
  async pressExport (): Promise<void> {
    if (!this.armedExport) {
      this.armedExport = true
      this.after('export', ARM_MS, () => { this.armedExport = false; this.local(); armEnded() })
      this.local()
      return
    }
    this.disarmExport()
    this.notice = null
    this.finishTransfer(await this.bridge.request('passwords', { type: 'export', confirm: true }))
    armEnded()
  }

  private finishTransfer (reply: unknown): void {
    if (isRecord(reply) && typeof reply['kind'] === 'string') this.notice = transferNotice(reply as unknown as TransferOutcome)
    else this.notice = { tone: 'error', text: 'That did not work.' }
    this.local()
  }

  private disarmExport (): void {
    this.clearTimer('export')
    this.armedExport = false
  }

  private say (text: string, where: 'list' | 'generated'): void {
    this.toast = { text, where }
    this.after('toast', TOAST_MS, () => { this.toast = null; this.changed() })
    this.changed()
  }

  private after (name: string, ms: number, run: () => void): void {
    this.clearTimer(name)
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); run() }, ms))
  }

  private clearTimer (name: string): void {
    const timer = this.timers.get(name)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(name)
  }

  /** A change only the list shows. */
  private local (): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** A change the rest of the section shows too. */
  private changed (): void {
    this.local()
    this.notify()
  }
}
