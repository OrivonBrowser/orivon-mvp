// The install of the release the check found: what is on offer, whether this copy can take it, and the one install
// that may run at a time, from download to restart. Electron-free: the download and the installer come in, so the order
// of steps, the progress and every failure are tested without a network or a disk.
import type { InstallerKind } from './install-kind.js'
import type { InstallResult } from './install-update.js'
import type { ReleaseInfo } from './update-check.js'
import type { ManifestFile } from './update-manifest.js'

export type Installability =
  | { readonly ok: true, readonly kind: InstallerKind, readonly file: ManifestFile }
  | { readonly ok: false, readonly why: string }

export type FlowPhase = 'idle' | 'downloading' | 'installing' | 'failed'

export interface FlowState {
  readonly phase: FlowPhase
  /** Whole percent of the download, while there is one. */
  readonly percent: number | null
  /** What went wrong, in a sentence for the person, once `phase` is `failed`. */
  readonly failure: string | null
}

export type InstallOutcome =
  | { readonly ok: true }
  | { readonly ok: false, readonly why: 'none' | 'unavailable' | 'failed', readonly reason: string, readonly declined: boolean }

export interface FlowDeps {
  readonly installability: (release: ReleaseInfo) => Promise<Installability>
  readonly download: (tag: string, file: ManifestFile, progress: (received: number, total: number) => void) => Promise<string>
  readonly install: (kind: InstallerKind, path: string) => Promise<InstallResult>
  readonly changed: (state: FlowState) => void
  readonly now: () => number
}

/** The percentage in a toast and in Settings moves at most this often. */
export const PROGRESS_EVERY_MS = 500

const IDLE: FlowState = { phase: 'idle', percent: null, failure: null }

export interface UpdateFlow {
  /** Sets the release on offer (null for none) and works out whether this copy can install it. */
  readonly offer: (release: ReleaseInfo | null) => Promise<void>
  readonly release: () => ReleaseInfo | null
  readonly installability: () => Installability | null
  readonly state: () => FlowState
  /** Downloads and installs the release on offer; a second call while one runs joins it. */
  readonly install: () => Promise<InstallOutcome>
}

export function createUpdateFlow (deps: FlowDeps): UpdateFlow {
  let offered: ReleaseInfo | null = null
  let able: Installability | null = null
  let state: FlowState = IDLE
  let running: Promise<InstallOutcome> | null = null

  const set = (next: FlowState): void => { state = next; deps.changed(state) }
  const busy = (): boolean => running !== null

  async function run (release: ReleaseInfo, choice: Extract<Installability, { ok: true }>): Promise<InstallOutcome> {
    let lastEmit = -Infinity
    set({ phase: 'downloading', percent: 0, failure: null })
    try {
      const path = await deps.download(release.version, choice.file, (received, total) => {
        const percent = Math.min(100, Math.floor(received / total * 100))
        const at = deps.now()
        if (percent !== state.percent && (at - lastEmit >= PROGRESS_EVERY_MS || percent === 100)) {
          lastEmit = at
          set({ phase: 'downloading', percent, failure: null })
        }
      })
      set({ phase: 'installing', percent: null, failure: null })
      const result = await deps.install(choice.kind, path)
      if (result.ok) return { ok: true }
      set({ phase: 'failed', percent: null, failure: result.reason })
      return { ok: false, why: 'failed', reason: result.reason, declined: result.declined }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The update could not be installed.'
      set({ phase: 'failed', percent: null, failure: reason })
      return { ok: false, why: 'failed', reason, declined: false }
    }
  }

  return {
    offer: async (release) => {
      if (busy()) return
      offered = release
      able = release === null ? null : await deps.installability(release)
      // An offer replaced by a later check forgets a failure that belonged to the one before.
      if (state.phase === 'failed' && release === null) set(IDLE)
    },
    release: () => offered,
    installability: () => able,
    state: () => state,
    install: async () => {
      if (running !== null) return await running
      const release = offered
      if (release === null) return { ok: false, why: 'none', reason: 'No update is on offer.', declined: false }
      if (able === null || !able.ok) return { ok: false, why: 'unavailable', reason: able?.why ?? 'This copy cannot install the update.', declined: false }
      const choice = able
      running = run(release, choice).finally(() => { running = null })
      return await running
    }
  }
}
