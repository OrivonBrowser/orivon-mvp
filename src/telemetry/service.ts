// The running telemetry of one profile process: it counts while the person's consent is live, sends
// when a report is due, and answers the Settings page and the welcome screen. Every effect it has on
// the outside (the clock, the network, the machine identifier, the windows) is injected, so the whole
// life cycle of a choice (accept, count, send, withdraw, delete) is tested without Electron.
//
// The consent is read fresh from the system-wide file on every tick and every question, never held:
// a choice made in another profile of the same computer applies here at the next tick.
import {
  applyEvent, periodOf, pruneSitePeriods, INTERNAL_SITE, SHELL_APP_ID, type AccountingState, type SiteKey, type TelemetryEvent
} from './accounting.js'
import { effectiveConsent, recordChoice, shouldOfferAtWelcome, type ConsentRecord, type ConsentSource } from './consent.js'
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
  /** Something a page may be showing changed. */
  readonly notify: () => void
}

export interface TelemetryStatus {
  readonly consent: ConsentState
  readonly region: Region
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
  private sendInFlight = false

  constructor (private readonly deps: ServiceDeps) {
    this.accounting = deps.store.getAccountingState()
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
    if (!live) return
    if (reconciled.transition === 'gained-focus') this.apply({ kind: 'focus', atMs: now, app: SHELL_APP_ID })
    else if (reconciled.transition === 'lost-focus') this.apply({ kind: 'blur', atMs: now })
    if (interacting) this.apply({ kind: 'interaction', atMs: now })
    this.apply({ kind: 'checkpoint', atMs: now })
    this.accounting = pruneSitePeriods(this.accounting, KEPT_SITE_PERIODS)
    this.deps.store.setAccountingState(this.accounting)
    await this.deps.store.checkpoint()
  }

  /** The browser is quitting: close the counting down and write it. */
  async stop (): Promise<void> {
    if (this.measuring) {
      this.apply({ kind: 'session-stop', atMs: this.deps.clock(), app: SHELL_APP_ID })
      this.measuring = false
    }
    await this.deps.store.checkpoint()
  }

  /** What the send timer does: send whatever is due, or, when consent is not live, empty every queue. */
  async sendTick (): Promise<void> {
    if (this.sendInFlight) return
    this.sendInFlight = true
    try {
      const consent = await this.consent()
      this.cycle = { ...this.cycle, accounting: this.accounting }
      const result = await runSendCycle(this.cycle, {
        consent,
        version: this.deps.version,
        region: this.deps.region(),
        stream: this.deps.store.getStream(),
        installId: () => this.installId(),
        reportIdFor: (period) => this.deps.store.reportIdFor(period),
        ...(this.deps.offsetWindowMs === undefined ? {} : { offsetWindowMs: this.deps.offsetWindowMs })
      }, this.deps.send, this.deps.clock)
      this.cycle = result.state
      this.deps.store.setHistoryState(result.state.history)
      this.deps.store.setSchedule('usage', result.state.usage.schedule)
      this.deps.store.setSchedule('sites', result.state.sites.schedule)
      if (result.sent.length > 0) {
        await this.deps.store.checkpoint()
        this.deps.notify()
      }
    } finally {
      this.sendInFlight = false
    }
  }

  /** Records the person's choice for the whole computer. Turning off empties both queues at once; nothing pending is sent. */
  async setOn (on: boolean, source: ConsentSource): Promise<void> {
    await this.deps.system.writeConsent(recordChoice(on ? 'accepted' : 'declined', this.deps.clock(), source))
    if (!on) this.cycle = withdrawn(this.cycle)
    await this.syncMeasuring()
    this.deps.notify()
  }

  /** Asks the server to delete everything under this install ID, turns telemetry off and forgets what was counted here. */
  async erase (): Promise<boolean> {
    await this.setOn(false, 'settings')
    const id = await this.installId()
    await this.deps.store.eraseMeasurements()
    this.accounting = this.deps.store.getAccountingState()
    this.cycle = this.cycleFromStore()
    const ok = await this.deps.sendErase(buildErasePayload(id))
    this.deps.notify()
    return ok
  }

  async status (): Promise<TelemetryStatus> {
    const consent = await this.consent()
    const installId = consent === 'accepted' ? await this.installId() : null
    const period = periodOf(this.deps.clock())
    return {
      consent,
      region: this.deps.region(),
      installId,
      usage: buildUsagePayload(this.accounting, { installId: installId ?? INSTALL_ID_PLACEHOLDER, stream: this.deps.store.getStream(), region: this.deps.region(), version: this.deps.version, period }),
      sites: buildSitesPayload(this.accounting, { reportId: this.deps.store.reportIdFor(period), version: this.deps.version, period }),
      sent: this.deps.store.getHistoryState().entries
    }
  }
}
