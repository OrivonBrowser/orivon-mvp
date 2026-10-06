// The browser's own update, wired to the machine: the daily look, the question in the window the person is using,
// the download, the install and the restart. Decisions live in the pure files beside it; this file only connects them
// to Electron, the disk and the windows, and is exercised by the end-to-end spec.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App } from 'electron'
import { withoutAddresses } from '../launch/launch-context.js'
import { askPlace } from '../os/install-default-browser-ask.js'
import { showToast } from '../page-tools/toast.js'
import { askQuestion } from '../shell/question/ask-question.js'
import type { ShellWindow, WindowRegistry } from '../shell/window-registry.js'
import { clearPending, downloadUpdate, PENDING_DIR } from './download-update.js'
import type { FetchLike } from './download-update.js'
import { installKind, MANUAL_WORDS, packageName } from './install-kind.js'
import type { InstallFacts } from './install-kind.js'
import { installPlan, installPreCheck } from './install-plan.js'
import { machineProbe, realInstallHost } from './install-host.js'
import { runInstall } from './install-update.js'
import type { InstallResult } from './install-update.js'
import { releaseUrl } from './release-url.js'
import { clearRestartMarker, writeRestartMarker } from './restart-marker.js'
import { buildAnswer } from './update-answer.js'
import type { UpdateAnswer } from './update-answer.js'
import { failureQuestion, readUpdateChoice, updateQuestion } from './update-ask.js'
import type { ReleaseInfo } from './update-check.js'
import { createUpdateChecker } from './update-checker.js'
import { createUpdateFlow } from './update-flow.js'
import type { FlowState, Installability } from './update-flow.js'
import { GITHUB_ENDPOINTS, createReleaseSource } from './update-source.js'
import type { UpdateEndpoints } from './update-source.js'
import { readUpdateState, writeUpdateState } from './update-state.js'
import { TRUSTED_UPDATE_KEYS } from './update-signing-key.js'
import { exposeCheckNow, recordInstall, updateSeam } from './update-test-seam.js'

export interface SelfUpdate {
  /** The daily look; asks the person when a signed, newer release is found. */
  readonly runScheduled: () => Promise<void>
  /** Looks now and answers; asks the person nothing. */
  readonly checkNow: () => Promise<UpdateAnswer>
  /** Installs the release the last look found, showing progress in `window`. */
  readonly install: (window: ShellWindow | undefined) => Promise<{ readonly ok: true } | { readonly ok: false, readonly reason: string }>
  /** The tag of the newer release on offer. */
  readonly foundTag: () => string | null
  readonly answer: () => UpdateAnswer
  readonly onChange: (listener: (answer: UpdateAnswer) => void) => () => void
}

export interface SelfUpdateDeps {
  readonly app: App
  readonly windows: Pick<WindowRegistry, 'focused'>
  /** A private session never looks, asks or installs. */
  readonly isPrivate: boolean
}

const SEAM_APPIMAGE = '/orivon-test/Orivon.AppImage'
const DPKG_QUERY_TIMEOUT_MS = 5000

/** Whether the system's package manager owns the running executable: how a deb install is told from a copy nothing manages. */
async function debOwns (execPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile('/usr/bin/dpkg-query', ['-S', execPath], { timeout: DPKG_QUERY_TIMEOUT_MS }, (error) => { resolve(error === null) })
  })
}

async function sha256Of (path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const toast = (window: ShellWindow | undefined, code: Parameters<typeof showToast>[1], name?: string): void => { if (window !== undefined) showToast(window, code, name) }

export function createSelfUpdate ({ app, windows, isPrivate }: SelfUpdateDeps): SelfUpdate {
  const seam = updateSeam()
  const userData = app.getPath('userData')
  const pendingDir = join(userData, PENDING_DIR)
  const statePath = join(userData, 'update-check-state.json')
  const current = app.getVersion()
  const endpoints: UpdateEndpoints = seam?.source === undefined
    ? GITHUB_ENDPOINTS
    : { list: `${seam.source}/releases`, asset: (tag, name) => `${seam.source ?? ''}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` }
  const fetchWithNet: FetchLike = async (url, init) => {
    const { net } = await import('electron')
    return await net.fetch(url, init)
  }
  const fetchLatest = createReleaseSource({
    fetch: fetchWithNet,
    endpoints,
    trustedKeys: seam?.key === undefined ? TRUSTED_UPDATE_KEYS : [...TRUSTED_UPDATE_KEYS, seam.key],
    log: (message) => { console.error(`[orivon] update-check: ${message}`) }
  })

  const listeners = new Set<(answer: UpdateAnswer) => void>()
  let reached = true
  let target: ShellWindow | undefined
  let facts: Promise<InstallFacts> | undefined
  const readFacts = async (): Promise<InstallFacts> => {
    facts ??= (async () => {
      const appImage = process.env['APPIMAGE']
      const base = { platform: process.platform, arch: process.arch, isPackaged: app.isPackaged, appImage, execPath: process.execPath }
      const manageable = process.platform === 'linux' && app.isPackaged && (appImage ?? '') === ''
      return { ...base, debOwned: manageable && await debOwns(process.execPath) }
    })()
    return await facts
  }

  const installability = async (release: ReleaseInfo): Promise<Installability> => {
    if (seam?.record === true) {
      const file = release.manifest?.files.find((entry) => entry.name === packageName('appimage', release.version.replace(/^v/, ''), 'x64'))
      return file === undefined ? { ok: false, why: MANUAL_WORDS.noPackage } : { ok: true, kind: 'appimage', file }
    }
    const machine = await readFacts()
    const kind = installKind(machine)
    if (kind.kind === 'manual') return { ok: false, why: MANUAL_WORDS[kind.why] }
    const file = release.manifest?.files.find((entry) => entry.name === packageName(kind.kind, release.version.replace(/^v/, ''), machine.arch))
    if (file === undefined) return { ok: false, why: MANUAL_WORDS.noPackage }
    const problem = installPreCheck(kind.kind, machine, machineProbe)
    return problem === undefined ? { ok: true, kind: kind.kind, file } : { ok: false, why: problem }
  }

  const install = async (kind: Parameters<typeof installPlan>[0], path: string): Promise<InstallResult> => {
    if (seam?.record === true) {
      recordInstall({ kind, file: path, sha256: await sha256Of(path) })
      return { ok: true }
    }
    const machine = await readFacts()
    const workDir = await mkdtemp(join(tmpdir(), 'orivon-update-'))
    // A restart that follows brings the windows back, whatever the start-up setting says.
    writeRestartMarker(userData)
    const restarter = {
      relaunch: (execPath: string) => { app.relaunch({ execPath, args: withoutAddresses(process.argv.slice(1), app.isPackaged) }) },
      // `quit`, never `exit`: the session and the stores flush before the browser closes.
      quit: () => { app.quit() }
    }
    try {
      const result = await runInstall(installPlan(kind, path, { ...machine, workDir }), realInstallHost(restarter))
      if (!result.ok) clearRestartMarker(userData)
      return result
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const flow = createUpdateFlow({
    installability,
    download: async (tag, file, progress) => await downloadUpdate({ fetch: fetchWithNet, url: endpoints.asset(tag, file.name), dir: pendingDir, file, progress }),
    install,
    changed: (state) => { showProgress(state); tell() },
    now: Date.now
  })

  const answer = (): UpdateAnswer => buildAnswer({ current, release: flow.release(), installability: flow.installability(), flow: flow.state(), reached })
  function tell (): void {
    const now = answer()
    for (const listener of listeners) listener(now)
  }
  function showProgress (state: FlowState): void {
    const version = flow.release()?.version.replace(/^v/, '') ?? ''
    if (state.phase === 'downloading') toast(target, 'updateDownloading', `${version} · ${String(state.percent ?? 0)}%`)
    else if (state.phase === 'installing') toast(target, 'updateInstalling', `${version}…`)
    else if (state.phase === 'failed') toast(target, 'updateFailed')
  }

  const openRelease = (window: ShellWindow | undefined): void => {
    const tag = flow.release()?.version ?? null
    if (window !== undefined && !window.window.isDestroyed()) window.tabs.createTab(releaseUrl(tag))
  }

  const run = async (window: ShellWindow | undefined): Promise<{ ok: true } | { ok: false, reason: string }> => {
    target = window
    const outcome = await flow.install()
    if (outcome.ok) return { ok: true }
    if (outcome.why === 'failed') {
      const tabId = window?.tabs.getState().activeTabId ?? undefined
      const answered = await askQuestion(window === undefined ? {} : { window, tabId }, failureQuestion(outcome.reason))
      if (answered.response === 0) openRelease(window ?? windows.focused())
    }
    return { ok: false, reason: outcome.reason }
  }

  const checker = createUpdateChecker({
    currentVersion: current,
    now: Date.now,
    read: async () => await readUpdateState(statePath),
    write: async (state) => { await writeUpdateState(statePath, state) },
    fetchLatest,
    offer: async (release) => { await flow.offer(release); tell() },
    ask: async (release) => {
      const place = askPlace(windows)
      if (place === undefined) return false
      const able = flow.installability() ?? { ok: false as const, why: MANUAL_WORDS.unsupported }
      const spec = updateQuestion(release.version.replace(/^v/, ''), current, able)
      const { response } = await askQuestion({ window: place.window, tabId: place.tabId }, spec)
      const choice = readUpdateChoice(response, able)
      if (choice === 'github') openRelease(place.window)
      if (choice === 'install') void run(place.window)
      return true
    }
  })

  if (!isPrivate) {
    exposeCheckNow(async () => { await checker.runScheduled() })
    void clearPending(pendingDir)
  }

  return {
    runScheduled: checker.runScheduled,
    checkNow: async () => {
      const result = await checker.checkNow()
      // No release to show, whether the source was out of reach or has none signed yet, reads the same to the person.
      reached = result.release !== null
      tell()
      return answer()
    },
    install: async (window) => await run(window),
    foundTag: () => flow.release()?.version ?? null,
    answer,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}
