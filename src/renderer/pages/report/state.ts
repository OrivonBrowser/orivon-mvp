// What the report page knows: the facts main gave it, what the person has chosen on the form, the literal text
// of the report those choices make, and the outcome of the last send. It builds nothing that is sent: main does,
// from the choices, so the preview and the send cannot differ.
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'

export interface CrashRow {
  readonly id: string
  readonly kind: string
  readonly at: string
  readonly process: string
  readonly reason: string
  readonly hasPage: boolean
  /** The size of the native dump that belongs to this crash, or null when there is none to send. */
  readonly dumpBytes: number | null
  readonly reported: boolean
}

export interface SentRow {
  readonly reportId: string
  readonly at: string
  readonly crashId?: string
  readonly summary: string
}

export interface ReportInfo {
  readonly private: boolean
  readonly limits: { readonly description: number, readonly contact: number }
  readonly crashes: readonly CrashRow[]
  readonly sent: readonly SentRow[]
}

export interface Choices {
  crashId: string | null
  description: string
  contact: string
  diagnostics: boolean
  log: boolean
  page: boolean
  dump: boolean
}

export type Outcome = { readonly kind: 'sent', readonly reportId: string } | { readonly kind: 'failed', readonly text: string }

export type TestKind = 'renderer' | 'main-error' | 'main-native'

export const PREVIEW_DELAY_MS = 150

export class ReportState {
  info: ReportInfo | null = null
  failed = false
  preview: { readonly text: string, readonly sendable: boolean, readonly bytes: number } | null = null
  outcome: Outcome | null = null
  sending = false
  readonly choices: Choices = { crashId: null, description: '', contact: '', diagnostics: true, log: true, page: false, dump: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private previewSeq = 0

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {}

  onChange (listener: () => void): void {
    this.listeners.add(listener)
  }

  private changed (): void {
    for (const listener of this.listeners) listener()
  }

  /** The crash the address names: `/crash/<id>`. */
  static crashOfPath (pathname: string): string | null {
    const [kind, id] = pathname.split('/').filter((part) => part !== '')
    return kind === 'crash' && id !== undefined ? id : null
  }

  get crash (): CrashRow | undefined {
    return this.info?.crashes.find((row) => row.id === this.choices.crashId)
  }

  async load (preselect: string | null): Promise<void> {
    try {
      const reply = await this.bridge.request('report', { type: 'state' }) as ReportInfo | undefined
      if (reply === undefined) throw new Error('no answer')
      this.info = reply
      this.failed = false
      if (preselect !== null && reply.crashes.some((row) => row.id === preselect)) this.choices.crashId = preselect
    } catch {
      this.failed = true
    }
    this.keepChoicesAvailable()
    this.changed()
    await this.refreshPreview()
  }

  /** A box for something the chosen crash does not have cannot stay ticked. */
  private keepChoicesAvailable (): void {
    const crash = this.crash
    if (crash === undefined || !crash.hasPage) this.choices.page = false
    if (crash === undefined || crash.dumpBytes === null) this.choices.dump = false
  }

  /** Records a change to the form and asks for the new preview shortly after, so typing does not ask for one per key. */
  set (change: Partial<Choices>): void {
    Object.assign(this.choices, change)
    this.keepChoicesAvailable()
    this.changed()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.refreshPreview() }, PREVIEW_DELAY_MS)
  }

  async refreshPreview (): Promise<void> {
    const seq = ++this.previewSeq
    try {
      const reply = await this.bridge.request('report', { type: 'preview', choices: this.choices }) as { text: string, sendable: boolean, bytes: number } | undefined
      if (seq !== this.previewSeq) return
      this.preview = reply ?? null
    } catch {
      if (seq !== this.previewSeq) return
      this.preview = null
    }
    this.changed()
  }

  get canSend (): boolean {
    return !this.sending && this.preview?.sendable === true
  }

  async send (): Promise<void> {
    if (!this.canSend) return
    this.sending = true
    this.outcome = null
    this.changed()
    try {
      const reply = await this.bridge.request('report', { type: 'send', choices: this.choices }) as { ok: boolean, reportId?: string, text?: string, sent?: SentRow[] } | undefined
      if (reply?.ok === true && reply.reportId !== undefined) {
        this.outcome = { kind: 'sent', reportId: reply.reportId }
        if (this.info !== null) this.info = { ...this.info, sent: reply.sent ?? this.info.sent, crashes: this.info.crashes.map((row) => row.id === this.choices.crashId ? { ...row, reported: true } : row) }
        this.choices.description = ''
      } else {
        this.outcome = { kind: 'failed', text: reply?.text ?? 'The report could not be sent.' }
      }
    } catch {
      this.outcome = { kind: 'failed', text: 'The report could not be sent.' }
    }
    this.sending = false
    this.changed()
    await this.refreshPreview()
  }

  /** Whether main put the Markdown on the clipboard. */
  async copy (): Promise<boolean> {
    try {
      return (await this.bridge.request('report', { type: 'copy', choices: this.choices }) as { ok?: boolean } | undefined)?.ok === true
    } catch {
      return false
    }
  }

  async erase (reportId: string): Promise<string | null> {
    try {
      const reply = await this.bridge.request('report', { type: 'erase', reportId }) as { ok: boolean, text?: string, sent?: SentRow[] } | undefined
      if (reply?.ok === true && this.info !== null) {
        this.info = { ...this.info, sent: reply.sent ?? [], crashes: this.info.crashes.map((row) => this.info?.sent.find((sent) => sent.reportId === reportId)?.crashId === row.id ? { ...row, reported: false } : row) }
        this.changed()
        return null
      }
      return reply?.text ?? 'Could not delete it.'
    } catch {
      return 'Could not delete it.'
    }
  }

  async runTest (kind: TestKind): Promise<void> {
    try {
      await this.bridge.request('report', { type: 'test', kind })
    } catch {
      // The browser may already be gone: that is what two of the tests do.
    }
  }

  async openNotice (): Promise<void> {
    try { await this.bridge.request('report', { type: 'notice' }) } catch { /* nothing to do */ }
  }

  /** Whether main put the ID of a report this computer sent on the clipboard. */
  async copyId (reportId: string): Promise<boolean> {
    try {
      return (await this.bridge.request('report', { type: 'copyId', reportId }) as { ok?: boolean } | undefined)?.ok === true
    } catch {
      return false
    }
  }
}
