// What the last look found, in words. The look is main's; the page shows the answer: the one its own "Check now"
// got, the release main's background look found (asked for on load), and what another open Settings window's look
// found, which arrives as `updates.changed`, so the windows agree without either asking again.
import type { OrivonInternal } from '../shared/bridge.js'

interface Answer {
  readonly reached: boolean
  readonly current: string
  readonly latest: string | null
  readonly newer: boolean
  readonly url: string | null
}

/** What Settings says where the Store delivers updates. */
export const STORE_UPDATES = 'Updates come from the Microsoft Store, which installs them by itself.'

export class UpdatesState {
  private answer: Answer | 'checking' | 'refused' | 'store' | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  /** True once this was for an `updates.changed` push: a look made elsewhere, or the release main's background look found or dropped (null). */
  handle (topic: string, payload: unknown): boolean {
    if (topic !== 'updates.changed') return false
    this.answer = payload as Answer | null
    this.changed()
    return true
  }

  /** Asks main what is on offer, so a release its background look found shows without pressing Check. */
  async load (): Promise<void> {
    const reply = await this.bridge.request('updates', { type: 'state' }) as { ok?: boolean, answer?: Answer | null } | undefined
    if (reply?.ok === true && reply.answer !== undefined && reply.answer !== null && this.answer === null) this.answer = reply.answer
  }

  async check (): Promise<void> {
    this.answer = 'checking'
    this.changed()
    const reply = await this.bridge.request('updates', { type: 'check' }) as { ok: boolean, answer?: Answer, reason?: string } | undefined
    this.answer = reply?.ok === true && reply.answer !== undefined ? reply.answer : reply?.reason === 'store' ? 'store' : 'refused'
    this.changed()
  }

  /** The version of a newer release the last check found, without a leading `v`; null when there is none. */
  available (): string | null {
    const answer = this.answer
    if (answer === null || answer === 'checking' || answer === 'refused' || answer === 'store' || !answer.newer || answer.latest === null) return null
    return answer.latest.replace(/^v/i, '')
  }

  /** Opens the release page in a tab of this window. Main builds the address from the answer it kept. */
  async openRelease (): Promise<void> {
    await this.bridge.request('updates', { type: 'openRelease' })
  }

  /** What was found, or '' before anything was asked. */
  words (): string {
    const answer = this.answer
    if (answer === null) return ''
    if (answer === 'checking') return 'Looking…'
    if (answer === 'store') return STORE_UPDATES
    if (answer === 'refused') return 'A private window looks at nothing.'
    if (!answer.reached) return 'Could not reach the release list. You may be offline, or none is published yet.'
    if (answer.newer) return `${answer.latest ?? ''} is available. You have ${answer.current}.`
    return `You have the latest release (${answer.current}).`
  }
}
