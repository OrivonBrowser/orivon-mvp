// The Electron side of the report page: reads the facts about this computer and build, sends over the network,
// writes the clipboard, runs the crash tests and opens the notice. The decisions are report-domain.ts's.
import { randomBytes } from 'node:crypto'
import { cpus, freemem, homedir, release, totalmem } from 'node:os'
import { app, clipboard, net, screen } from 'electron'
import type { WebContents } from 'electron'
import { devModeEnabled } from '../dev/dev-mode.js'
import type { SubsystemContext } from '../registry.js'
import type { ShellServices } from '../shell/shell-services.js'
import { IS_TEST_BUILD, ingestBaseUrl, modeInputsFromEnv, testOverrides } from '../../telemetry/mode.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { BUILD_COMMIT } from './build-commit.js'
import { buildDiagnostics, channelOf, reportedSettings } from './diagnostics-facts.js'
import type { DiagnosticsFacts } from './diagnostics-facts.js'
import { diagnostics } from './diagnostics-runner.js'
import { readDumpBase64 } from './dump-files.js'
import type { Post } from './report-channel.js'
import { reportDomain } from './report-domain.js'
import type { TestKind } from './report-domain.js'
import { SentStore } from './sent-reports.js'
import { join } from 'node:path'

function id32 (): string {
  return randomBytes(16).toString('hex')
}

const post: Post = async (url, body, timeoutMs) => {
  const response = await net.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) })
  // Only the status is read: the server's answer to a report is its status and nothing else.
  return { status: response.status }
}

/** Reports go where telemetry does, but not under its switches: sending one is the person's own act. */
function base (): string {
  return ingestBaseUrl(IS_TEST_BUILD, testOverrides().url, modeInputsFromEnv(process.env, devModeEnabled(), false).development)
}

async function readFacts (services: ShellServices, ctx: SubsystemContext): Promise<DiagnosticsFacts> {
  const gpuInfo = await app.getGPUInfo('basic').catch(() => undefined)
  const windows = services.windows.all().filter((window) => !window.window.isDestroyed())
  const processors = cpus()
  return {
    commit: BUILD_COMMIT,
    channel: channelOf({ development: devModeEnabled() || (process.env['ELECTRON_RENDERER_URL'] ?? '') !== '', packaged: app.isPackaged, platform: process.platform, appImage: (process.env['APPIMAGE'] ?? '') !== '' }),
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
    packaged: app.isPackaged,
    uptimeSec: process.uptime(),
    system: {
      platform: process.platform,
      release: release(),
      arch: process.arch,
      cpus: processors.length,
      cpuModel: processors[0]?.model ?? '',
      memoryMb: Math.round(totalmem() / 1048576),
      freeMemoryMb: Math.round(freemem() / 1048576),
      locale: app.getLocale(),
      session: process.env['XDG_SESSION_TYPE'] ?? '',
      desktop: process.env['XDG_CURRENT_DESKTOP'] ?? '',
      ozone: app.commandLine.getSwitchValue('ozone-platform')
    },
    gpuStatus: app.getGPUFeatureStatus(),
    gpuInfo,
    displays: screen.getAllDisplays().map((display) => ({ width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor })),
    processes: app.getAppMetrics().map((metric) => ({ type: metric.type, workingSetKb: metric.memory.workingSetSize })),
    browser: {
      windows: windows.length,
      tabs: windows.reduce((sum, window) => sum + window.tabs.getState().tabs.length, 0),
      privateSession: services.isPrivate,
      extensions: (ctx.extensions?.list() ?? []).map(({ id, name, version, enabled }) => ({ id, name, version, enabled })),
      settings: reportedSettings((key) => services.settings.get(key))
    },
    crashes: diagnostics()?.crashes() ?? []
  }
}

/** Opens a tab and ends its page process the way a crash does, deferred so the click that asked returns first. */
function crashATab (services: ShellServices, page: WebContents): void {
  const owner = services.windows.findOwner(page)
  if (owner === undefined) return
  const target = owner.tabs.liveWebContents(owner.tabs.createTab('about:blank'))
  if (target === undefined) return
  const crash = (): void => { setTimeout(() => { if (!target.isDestroyed()) target.forcefullyCrashRenderer() }, 0) }
  if (target.isLoading()) target.once('did-stop-loading', crash)
  else crash()
}

function runTest (services: ShellServices, kind: TestKind, page: WebContents): void {
  if (kind === 'renderer') {
    crashATab(services, page)
  } else if (kind === 'main-error') {
    // Thrown from a timer, the way a real bug in the main process reaches the process: start.ts's handler records it and exits.
    setTimeout(() => { throw new Error('Test crash: thrown on purpose from orivon://report') }, 100)
  } else {
    setTimeout(() => { process.crash() }, 100)
  }
}

export function reportDomainFor (services: ShellServices, ctx: SubsystemContext): InternalDomain {
  const service = diagnostics()
  const sent = new SentStore(join(app.getPath('userData'), 'diagnostics'))
  return reportDomain({
    isPrivate: services.isPrivate,
    version: app.getVersion(),
    home: homedir(),
    ignoreCase: process.platform === 'win32',
    crashes: {
      crashes: () => service?.crashes() ?? [],
      crash: (id) => service?.crash(id),
      dumpOf: (record) => service?.dumpOf(record),
      markReported: (crashId, reportId) => { service?.markReported(crashId, reportId) }
    },
    sent: { all: () => sent.all(), add: (entry) => { sent.add(entry) }, remove: (reportId) => { sent.remove(reportId) } },
    diagnostics: async () => buildDiagnostics(await readFacts(services, ctx)),
    logLines: (crash) => service?.logLines(crash) ?? [],
    readDump: readDumpBase64,
    newReportId: id32,
    post,
    base,
    now: Date.now,
    copy: (text) => { clipboard.writeText(text) },
    openNotice: (page) => { services.windows.findOwner(page)?.tabs.openInternal('settings', '/privacy') },
    runTest: (kind, page) => { runTest(services, kind, page) }
  })
}
