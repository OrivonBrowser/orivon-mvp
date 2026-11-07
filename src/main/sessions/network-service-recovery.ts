// The order of a network-service restart: requests wait, the new service is waited for, each setting that lived on the old
// one is sent to every session again, and the requests go on. What it knows of Electron is what it is given, so the order
// and its failures are tested with fakes; network-service-runner.ts supplies the real ones.
import type { HoldReport, NetworkServiceRestart } from './network-service-restart.js'

/** One thing Orivon set on the network service that the next one starts without. */
export interface Reapplier<Target> {
  readonly name: string
  /** Sends the setting again to every `target`; a throw is logged and the other settings still go. Returns a few words on what it sent, or undefined when there was nothing to send. */
  readonly reapply: (targets: readonly Target[]) => string | undefined
}

export interface RecoveryDeps<Target> {
  readonly restart: NetworkServiceRestart
  /** Resolves once the new service answers every `target`; a rejection is taken as "now, as best as can be told". */
  readonly ready: (targets: readonly Target[]) => Promise<void>
  readonly targets: () => readonly Target[]
  readonly reappliers: () => readonly Reapplier<Target>[]
  readonly now: () => number
  readonly log: (line: string) => void
  /** The hold began: whatever has to keep requests waiting (a handler on each session) starts now. */
  readonly holdBegan: () => void
}

export interface Ended {
  readonly reason: string
  readonly exitCode: number | null
}

const word = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

export class NetworkServiceRecovery<Target> {
  constructor (private readonly deps: RecoveryDeps<Target>) {}

  /** The network service ended. Resolves when the settings have been sent again: true, or false when a later end superseded this one and left the sending to its own. */
  async onEnded (ended: Ended): Promise<boolean> {
    const { restart, log, now } = this.deps
    const begun = now()
    const generation = restart.gone()
    this.deps.holdBegan()
    log(`[network-service] the network service ended (${ended.reason}${ended.exitCode === null ? '' : `, exit code ${String(ended.exitCode)}`}); requests wait until its settings are sent again`)
    const targets = this.deps.targets()
    let answeredAfter = ''
    try {
      await this.deps.ready(targets)
      answeredAfter = `, answering after ${String(now() - begun)} ms`
    } catch (error) {
      log(`[network-service] could not tell when the new service was up (${String(error)}); sending its settings anyway`)
    }
    if (!restart.isCurrent(generation)) {
      log('[network-service] the network service ended again before its settings were sent; the later restart sends them')
      return false
    }
    const failed: string[] = []
    const sent: string[] = []
    for (const reapplier of this.deps.reappliers()) {
      try {
        const detail = reapplier.reapply(targets)
        if (detail !== undefined) sent.push(`${reapplier.name} (${detail})`)
      } catch (error) {
        failed.push(reapplier.name)
        log(`[network-service] could not send the ${reapplier.name} again: ${String(error)}`)
      }
    }
    restart.reapplied(generation)
    const took = now() - begun
    const tail = failed.length === 0 ? '' : `; not sent: ${failed.join(', ')}`
    log(`[network-service] settings sent again ${String(took)} ms after the service ended${answeredAfter}: ${sent.length === 0 ? 'none to send' : sent.join(', ')}${tail}`)
    return true
  }
}

/** The line written when a hold ends. */
export function holdLine (report: HoldReport): string {
  const requests = word(report.requests, 'request', 'requests')
  return report.outcome === 'reapplied'
    ? `[network-service] ${requests} waited ${String(report.heldMs)} ms and went on`
    : `[network-service] the settings were not sent again within ${String(report.heldMs)} ms: ${requests} went on without them`
}

export interface AnswerOptions {
  /** The longest to keep asking. */
  readonly boundMs: number
  /** How long one call may go unanswered before it is asked again: a call made to a context that is gone may never come back. */
  readonly attemptMs?: number
  /** The wait between one call's refusal and the next. */
  readonly retryMs?: number
  /** True once nobody wants the answer any more: the asking stops. */
  readonly stop?: () => boolean
}

const pause = async (ms: number): Promise<void> => await new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * Asks until `ask` is answered, and returns how many times it was asked. A call made while the old context is being torn
 * down is refused (`ERR_FAILED`), and one made before the new one exists may never be answered, so each is asked again
 * until one gets an answer; that answer is what says the context a setting would be sent to is the new one.
 */
export async function untilAnswered (ask: () => Promise<unknown>, options: AnswerOptions): Promise<number> {
  const { boundMs, attemptMs = 250, retryMs = 5, stop = () => false } = options
  const deadline = Date.now() + boundMs
  for (let tries = 1; ; tries += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const silent = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, attemptMs) })
    const answered = await Promise.race([ask().then(() => true, () => false), silent])
    clearTimeout(timer)
    if (answered) return tries
    if (Date.now() >= deadline || stop()) throw new Error(`no answer after ${String(tries)} tries`)
    await pause(retryMs)
  }
}
