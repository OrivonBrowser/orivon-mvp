// What "Check now" found, in words. The check is main's; the page shows the answer.
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

  async check (): Promise<void> {
    this.answer = 'checking'
    this.changed()
    const reply = await this.bridge.request('updates', { type: 'check' }) as { ok: boolean, answer?: Answer } | undefined
    this.answer = reply?.ok === true && reply.answer !== undefined ? reply.answer : 'refused'
    this.changed()
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
