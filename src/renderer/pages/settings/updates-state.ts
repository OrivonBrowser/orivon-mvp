// What "Check now" found, in words. The check is main's; the page shows the
// answer. Another open Settings window's own "Check now" arrives as
// `updates.changed`, so the two windows agree without either asking again.
import type { OrivonInternal } from '../shared/bridge.js'

interface Answer {
  readonly reached: boolean
  readonly current: string
  readonly latest: string | null
  readonly newer: boolean
  readonly url: string | null
}

export class UpdatesState {
  private answer: Answer | 'checking' | 'refused' | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  /** True once this was for an `updates.changed` push -- another window's own check, never this one's (it already set `answer` itself). */
  handle (topic: string, payload: unknown): boolean {
    if (topic !== 'updates.changed') return false
    this.answer = payload as Answer
    this.changed()
    return true
  }

  async check (): Promise<void> {
    this.answer = 'checking'
    this.changed()
    const reply = await this.bridge.request('updates', { type: 'check' }) as { ok: boolean, answer?: Answer } | undefined
    this.answer = reply?.ok === true && reply.answer !== undefined ? reply.answer : 'refused'
    this.changed()
  }

  /** The version of a newer release the last check found, without a leading `v`; null when there is none. */
  available (): string | null {
    const answer = this.answer
    if (answer === null || answer === 'checking' || answer === 'refused' || !answer.newer || answer.latest === null) return null
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
    if (answer === 'refused') return 'A private window looks at nothing.'
    if (!answer.reached) return 'Could not reach the release list. You may be offline, or none is published yet.'
    if (answer.newer) return `${answer.latest ?? ''} is available. You have ${answer.current}.`
    return `You have the latest release (${answer.current}).`
  }
}
