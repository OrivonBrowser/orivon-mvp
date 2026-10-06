// The running telemetry of one profile process: it counts while the person's consent is live, sends
// when a report is due, and answers the Settings page and the welcome screen. Every effect it has on
// the outside (the clock, the network, the machine identifier, the windows) is injected, so the whole
// life cycle of a choice (accept, count, send, withdraw, delete) is tested without Electron.
//
// The consent is read fresh from the system-wide file on every tick and every question, never held:
// a choice made in another profile of the same computer applies here at the next tick.
import {
  applyEvent, periodOf, pruneSitePeriods, resetSession, INTERNAL_SITE, SHELL_APP_ID, type AccountingState, type SiteKey, type TelemetryEvent
} from './accounting.js'
import { NOTICE_VERSION, effectiveConsent, recordChoice, shouldOfferAtWelcome, type ConsentRecord, type ConsentSource } from './consent.js'
import {
  INSTALL_ID_PLACEHOLDER, buildErasePayload, buildSitesPayload, buildUsagePayload, type ConsentState, type ErasePayload,
  type SitesPayload, type UsagePayload
} from './disclosure.js'
import { initialKindState, runSendCycle, withdrawn, type SendCycleState } from './engine.js'
import type { HistoryEntry } from './history.js'
import { resolveInstallId, type MachineIdReaders } from './install-id.js'
import type { Region } from './region.js'
import type { SystemStore } from './system-store.js'
import type { TelemetryStore } from './store.js'
import type { Sender } from './transport.js'
import { reconcileWindowFocus, type TrackedWindow } from './window-focus.js'

export interface ServiceDeps {
  readonly store: TelemetryStore
  readonly system: SystemStore
  readonly version: string
  readonly region: () => Region
  readonly machineReaders: MachineIdReaders
  readonly randomId: () => string
  readonly clock: () => number
  readonly send: Sender
  readonly sendErase: (payload: ErasePayload) => Promise<boolean>
  /** The width of a period's random send offset; a test build may narrow it. */
  readonly offsetWindowMs?: number
  /** How often a running month's snapshot goes again; a test build may shorten it from a day. */
  readonly snapshotEveryMs?: number
  /** Something a page may be showing changed. */
  readonly notify: () => void
}

export interface TelemetryStatus {
  readonly consent: ConsentState
  readonly region: Region
  /** Whether the person ever accepted: with no acceptance nothing was sent, so there is nothing to delete. */
  readonly everAccepted: boolean
  /** The ID this computer reports under, once telemetry is on; null before, because the machine is not read until then. */
  readonly installId: string | null
  readonly usage: UsagePayload
  readonly sites: SitesPayload
  readonly sent: readonly HistoryEntry[]
}

/** How many months of the site split stay on disk: the running one, the one just closed, and one spare. */
const KEPT_SITE_PERIODS = 3

export class TelemetryService {
  private cycle: SendCycleState
  private accounting: AccountingState
  private measuring = false
  private focusedIds: ReadonlySet<number> = new Set()
  private siteInFront: SiteKey = INTERNAL_SITE
  private cachedInstallId: string | undefined
  /** The send cycle running now, if any. */
  private sending: Promise<void> | undefined
  /** Bumped by every withdrawal and erase: a send cycle that began under an older number writes nothing back. */
  private generation = 0
  /** Counting changed since the last write to disk. */
  private dirty = false

  constructor (private readonly deps: ServiceDeps) {
    // The sessions the previous process had open are not this one's: an interval it never closed is never credited.
    this.accounting = resetSession(deps.store.getAccountingState())
    this.cycle = this.cycleFromStore()
  }

  private cycleFromStore (): SendCycleState {
    const { store } = this.deps
    return {
      accounting: this.accounting,
      history: store.getHistoryState(),
      usage: { ...initialKindState, schedule: store.getSchedule('usage') },
      sites: { ...initialKindState, schedule: store.getSchedule('sites') }
    }
  }

  async consentRecord (): Promise<ConsentRecord> {
    return await this.deps.system.readConsent()
  }

  async consent (): Promise<ConsentState> {
    return effectiveConsent(await this.consentRecord())
  }

  async offerAtWelcome (): Promise<boolean> {
    return shouldOfferAtWelcome(await this.consentRecord(), this.deps.clock())
  }

  private installIdFor (): Promise<string> {
    return resolveInstallId(
      this.deps.machineReaders,
      { read: () => this.deps.system.readFallbackId(), write: (id) => this.deps.system.writeFallbackId(id) },
      this.deps.randomId
    )
  }

  private async installId (): Promise<string> {
    this.cachedInstallId ??= await this.installIdFor()
    return this.cachedInstallId
  }

  private apply (event: TelemetryEvent): void {
    this.accounting = applyEvent(this.accounting, event)
    this.deps.store.setAccountingState(this.accounting)
    this.dirty = true
  }

  /** Starts or stops counting to match the consent as it is now. */
  private async syncMeasuring (): Promise<boolean> {
    const live = (await this.consent()) === 'accepted'
    const now = this.deps.clock()
    if (live && !this.measuring) {
      this.measuring = true
      this.apply({ kind: 'session-start', atMs: now, app: SHELL_APP_ID })
      this.apply({ kind: 'site', atMs: now, site: this.siteInFront })
      if (this.focusedIds.size > 0) this.apply({ kind: 'focus', atMs: now, app: SHELL_APP_ID })
    } else if (!live && this.measuring) {
      this.measuring = false
      this.apply({ kind: 'blur', atMs: now })
      this.apply({ kind: 'session-stop', atMs: now, app: SHELL_APP_ID })
    }
    return live
  }

  /** The site now in front changed. Remembered even while nothing is counted, so counting starts on the right one. */
  noteSite (site: SiteKey): void {
    this.siteInFront = site
    if (this.measuring) this.apply({ kind: 'site', atMs: this.deps.clock(), site })
  }

  /** A suspend or resume of the computer. */
  notePower (kind: 'suspend' | 'resume'): void {
    if (this.measuring) this.apply({ kind, atMs: this.deps.clock() })
  }

  /** What the checkpoint timer does: follow the consent, follow the windows, settle the counting and write it down. */
  async checkpointTick (windows: readonly TrackedWindow[], interacting: boolean): Promise<void> {
    const live = await this.syncMeasuring()
    const now = this.deps.clock()
    const reconciled = reconcileWindowFocus(this.focusedIds, windows)
    this.focusedIds = reconciled.nextFocusedIds
    if (!live) {
      // Counting stopped since the last write (a withdrawal made in another profile): write its end, local state only.
      if (this.dirty) await this.writeLocal()
      return
    }
    if (reconciled.transition === 'gained-focus') this.apply({ kind: 'focus', atMs: now, app: SHELL_APP_ID })
    else if (reconciled.transition === 'lost-focus') this.apply({ kind: 'blur', atMs: now })
    if (interacting) this.apply({ kind: 'interaction', atMs: now })
    this.apply({ kind: 'checkpoint', atMs: now })
    this.accounting = pruneSitePeriods(this.accounting, KEPT_SITE_PERIODS)
    this.deps.store.setAccountingState(this.accounting)
    await this.writeLocal()
  }

  private async writeLocal (): Promise<void> {
    this.dirty = false
    await this.deps.store.checkpoint()
  }

  /** The browser is quitting: close the counting down and write it. */
  async stop (): Promise<void> {
    if (this.measuring) {
      this.apply({ kind: 'session-stop', atMs: this.deps.clock(), app: SHELL_APP_ID })
      this.measuring = false
    }
    await this.writeLocal()
  }

  /** What the send timer does: send whatever is due, or, when consent is not live, empty every queue. */
  async sendTick (): Promise<void> {
    if (this.sending !== undefined) return
    const running = this.runSend().finally(() => { this.sending = undefined })
    this.sending = running
    await running
  }

  private async runSend (): Promise<void> {
    const generation = this.generation
    this.cycle = { ...this.cycle, accounting: this.accounting }
    const result = await runSendCycle(this.cycle, {
      consent: () => this.consent(),
      version: this.deps.version,
      region: this.deps.region(),
      stream: this.deps.store.getStream(),
      installId: () => this.installId(),
      reportIdFor: (period) => this.deps.store.reportIdFor(period),
      ...(this.deps.offsetWindowMs === undefined ? {} : { offsetWindowMs: this.deps.offsetWindowMs }),
      ...(this.deps.snapshotEveryMs === undefined ? {} : { snapshotEveryMs: this.deps.snapshotEveryMs })
    }, this.deps.send, this.deps.clock)
    // A withdrawal or an erase happened while this ran: what it found out is stale, and writing it back would undo them.
    if (generation !== this.generation) return
    this.cycle = result.state
    this.deps.store.setHistoryState(result.state.history)
    this.deps.store.setSchedule('usage', result.state.usage.schedule)
    this.deps.store.setSchedule('sites', result.state.sites.schedule)
    if (result.sent.length > 0) {
      await this.writeLocal()
      this.deps.notify()
    }
  }

  /** Records the person's choice for the whole computer. Turning off empties both queues at once and lets a send in flight finish into nothing. */
  async setOn (on: boolean, source: ConsentSource): Promise<void> {
    await this.deps.system.writeConsent(recordChoice(on ? 'accepted' : 'declined', this.deps.clock(), source, NOTICE_VERSION, await this.consentRecord()))
    if (!on) {
      this.generation += 1
      await this.sending?.catch(() => {})
      this.cycle = withdrawn(this.cycle)
    }
    await this.syncMeasuring()
    await this.writeLocal()
    this.deps.notify()
  }

  /**
   * Asks the server to delete everything under this install ID, turns telemetry off and forgets what was
   * counted here. 'nothing' when the person never accepted: nothing was sent, and the machine is not read.
   */
  async erase (): Promise<'nothing' | 'done' | 'failed'> {
    if (!(await this.consentRecord()).everAccepted) return 'nothing'
    await this.setOn(false, 'settings')
    const id = await this.installId()
    await this.deps.store.eraseMeasurements()
    this.accounting = this.deps.store.getAccountingState()
    this.cycle = this.cycleFromStore()
    const ok = await this.deps.sendErase(buildErasePayload(id))
    // Deleted: nothing is left under that ID, so there is nothing more to delete until the person accepts again.
    if (ok) await this.deps.system.writeConsent({ ...(await this.consentRecord()), everAccepted: false })
    this.deps.notify()
    return ok ? 'done' : 'failed'
  }

  async status (): Promise<TelemetryStatus> {
    const consent = await this.consent()
    const installId = consent === 'accepted' ? await this.installId() : null
    const period = periodOf(this.deps.clock())
    return {
      consent,
      region: this.deps.region(),
      everAccepted: (await this.consentRecord()).everAccepted,
      installId,
      usage: buildUsagePayload(this.accounting, { installId: installId ?? INSTALL_ID_PLACEHOLDER, stream: this.deps.store.getStream(), region: this.deps.region(), version: this.deps.version, period }),
      sites: buildSitesPayload(this.accounting, { reportId: this.deps.store.reportIdFor(period), version: this.deps.version, period }),
      sent: this.deps.store.getHistoryState().entries
    }
  }
}
