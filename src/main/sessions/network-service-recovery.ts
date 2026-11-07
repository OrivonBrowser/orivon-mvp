// The order of a network-service restart: requests wait, the new service is waited for, each setting that lived on the old
// one is sent again, and the requests go on. A setting of one session is sent to it when its own network context answers, not
// before: a session whose context is not the new one yet would be given its setting on a context that is about to be
// dropped. What it knows of Electron is what it is given, so the order and its failures are tested with fakes;
// network-service-runner.ts supplies the real ones.
import type { HoldReport, NetworkServiceRestart } from './network-service-restart.js'

/** One thing Orivon set on the network service as a whole that the next one starts without. */
export interface ServiceSetting {
  readonly name: string
  /** Sends the setting again, once the new service answers; a throw is logged and the other settings still go. Returns a few words on what it sent, or undefined when there was nothing to send. */
  readonly reapply: () => string | undefined
}

/** One thing Orivon set on a session's network context that the next one starts without. */
export interface SessionSetting<Target> {
  readonly name: string
  /** Sends the setting again to `target`, once that session's own context answers; a throw is logged and the other settings still go. */
  readonly reapply: (target: Target) => void
}

export interface RecoveryDeps<Target> {
  readonly restart: NetworkServiceRestart
  /** The session whose answer says the new service is up: the settings of the service as a whole wait for it. */
  readonly primary: () => Target
  /** Resolves once `target`'s own network context answers; rejects when it does not within the bound, or once `stop` says nobody wants the answer. */
  readonly answers: (target: Target, stop: () => boolean) => Promise<void>
  /** Every session that exists now. */
  readonly targets: () => readonly Target[]
  /** Calls `listener` with each session made from now on; the returned function stops it. */
  readonly watch: (listener: (target: Target) => void) => () => void
  /** Waited for once the primary session has settled, before anything is sent: a test build holds the settings back here. */
  readonly beforeSending?: () => Promise<void>
  /** How long the other sessions are given to answer once the primary has: a session nobody uses may be slow, and must not delay the rest. */
  readonly graceMs: number
  readonly serviceSettings: () => readonly ServiceSetting[]
  readonly sessionSettings: () => readonly SessionSetting<Target>[]
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

/** Where one session stands: its context has not answered, its settings were sent, or it never answered. */
type Standing = 'asking' | 'sent' | 'silent'

export class NetworkServiceRecovery<Target> {
  constructor (private readonly deps: RecoveryDeps<Target>) {}

  /**
   * The network service ended. Resolves when the settings have been sent again to the sessions that answered: true, or
   * false when a later end superseded this one and left the sending to its own. A session that answers after that is sent
   * its settings when it does, up to the bound, and the log says how many did not.
   */
  async onEnded (ended: Ended): Promise<boolean> {
    const { restart, log, now, graceMs } = this.deps
    const begun = now()
    const generation = restart.gone()
    this.deps.holdBegan()
    log(`[network-service] the network service ended (${ended.reason}${ended.exitCode === null ? '' : `, exit code ${String(ended.exitCode)}`}); requests wait until its settings are sent again`)
    const current = (): boolean => restart.isCurrent(generation)
    const standing = new Map<Target, Standing>()
    const followed = new Map<Target, Promise<void>>()
    /** Why each session did not answer, or undefined if it did; never rejects. */
    const whyNot = new Map<Target, Promise<string | undefined>>()
    const sentTo = new Map<string, number>()
    const failed = new Set<string>()
    let open: () => void = () => {}
    const sendingOpen = new Promise<void>((resolve) => { open = resolve })

    const sendTo = (target: Target): void => {
      for (const setting of this.deps.sessionSettings()) {
        try {
          setting.reapply(target)
          sentTo.set(setting.name, (sentTo.get(setting.name) ?? 0) + 1)
        } catch (error) {
          failed.add(setting.name)
          log(`[network-service] could not send the ${setting.name} again to a session: ${String(error)}`)
        }
      }
    }
    /** Asks `target` until it answers, and sends it its settings then: the answer is what says its context is the new one. */
    const ask = (target: Target): void => {
      if (standing.has(target)) return
      standing.set(target, 'asking')
      const answer = this.deps.answers(target, () => !current()).then((): undefined => undefined, (error: unknown) => String(error))
      whyNot.set(target, answer)
      followed.set(target, answer.then(async (why) => {
        if (why !== undefined) { standing.set(target, 'silent'); return }
        await sendingOpen
        if (!current()) return
        sendTo(target)
        standing.set(target, 'sent')
      }))
    }

    const primary = this.deps.primary()
    ask(primary)
    for (const target of this.deps.targets()) ask(target)
    const unwatch = this.deps.watch(ask)
    const why = await whyNot.get(primary)
    const answeredAfter = why === undefined ? `, answering after ${String(now() - begun)} ms` : ''
    if (why !== undefined) log(`[network-service] could not tell when the new service was up (${why}); sending its settings anyway`)
    await this.deps.beforeSending?.()
    open()
    if (!current()) {
      unwatch()
      log('[network-service] the network service ended again before its settings were sent; the later restart sends them')
      return false
    }
    const sent: string[] = []
    for (const setting of this.deps.serviceSettings()) {
      try {
        const detail = setting.reapply()
        if (detail !== undefined) sent.push(`${setting.name} (${detail})`)
      } catch (error) {
        failed.add(setting.name)
        log(`[network-service] could not send the ${setting.name} again: ${String(error)}`)
      }
    }
    await followed.get(primary)
    /** Every session asked so far, including one made while the others were still being waited for. */
    const everyone = async (): Promise<void> => {
      for (let asked = 0; asked < followed.size;) {
        asked = followed.size
        await Promise.all([...followed.values()])
      }
    }
    let grace: ReturnType<typeof setTimeout> | undefined
    await Promise.race([everyone(), new Promise<void>((resolve) => { grace = setTimeout(resolve, graceMs) })])
    clearTimeout(grace)
    unwatch()
    if (!current()) {
      log('[network-service] the network service ended again before its settings were sent; the later restart sends them')
      return false
    }
    const late = [...standing].filter(([, state]) => state === 'asking').map(([target]) => target)
    for (const [name, count] of sentTo) sent.push(`${name} (${word(count, 'session', 'sessions')})`)
    restart.reapplied(generation)
    const tail = failed.size === 0 ? '' : `; not sent: ${[...failed].join(', ')}`
    log(`[network-service] settings sent again ${String(now() - begun)} ms after the service ended${answeredAfter}: ${sent.length === 0 ? 'none to send' : sent.join(', ')}${tail}`)
    this.settleLate(late, standing, followed, current, begun).catch((error: unknown) => { log(`[network-service] could not finish sending the settings to the late sessions: ${String(error)}`) })
    return true
  }

  /** The sessions that had not answered when the requests went on keep being asked, up to the bound; then the log says how many answered late and how many never did. */
  private async settleLate (late: readonly Target[], standing: ReadonlyMap<Target, Standing>, followed: ReadonlyMap<Target, Promise<void>>, current: () => boolean, begun: number): Promise<void> {
    await Promise.all([...followed.values()])
    if (!current()) return
    const { log, now } = this.deps
    const all = standing.size
    const answeredLate = late.filter((target) => standing.get(target) === 'sent').length
    const silent = [...standing.values()].filter((state) => state === 'silent').length
    if (answeredLate > 0) log(`[network-service] ${String(answeredLate)} of ${word(all, 'session', 'sessions')} answered after the requests went on, and were sent their settings then`)
    if (silent > 0) log(`[network-service] ${String(silent)} of ${word(all, 'session', 'sessions')} did not answer within ${String(now() - begun)} ms, and were not sent their settings`)
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
