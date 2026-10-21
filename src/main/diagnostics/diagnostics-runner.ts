// The Electron wiring of diagnostics: the log capture and the run marker at the start of `boot()`, the crash
// reporter (with uploads off), and the events that say a page or a child process died. What each of them
// decides is in the pure modules and the service beside this file; this file only connects them to the process.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app, crashReporter } from 'electron'
import type { WebContents } from 'electron'
import type { Subsystem } from '../registry.js'
import { setCrashLookups, takeEndedOnPurpose } from './crash-lookup.js'
import { DiagnosticsService } from './diagnostics-service.js'
import { captureConsole } from './log-ring.js'
import { childProcessName, isOrdinaryEnd, processName, rendererLine, shellPageName } from './shell-console.js'
import { isShellSchemeUrl } from '../shell/shell-session.js'

let service: DiagnosticsService | undefined
let classify: (contents: WebContents) => { internalPage: string | undefined, isTab: boolean } = () => ({ internalPage: undefined, isTab: true })
let quitting = false

/** The one service of this process, once `startDiagnostics` has run. */
export function diagnostics (): DiagnosticsService | undefined {
  return service
}

/** What the shell knows of a page, so a report can name the process that died; set once the shell's windows exist. */
export function setPageClassifier (classifier: typeof classify): void {
  classify = classifier
}

function devOrigin (): string | undefined {
  const url = process.env['ELECTRON_RENDERER_URL']
  try {
    return url === undefined || url === '' ? undefined : new URL(url).origin
  } catch {
    return undefined
  }
}

function attachRendererLog (contents: WebContents, log: DiagnosticsService): void {
  contents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    // Before anything is looked up: a website can log thousands of lines a second, and only warnings and errors are kept.
    if (level !== 'warning' && level !== 'error') return
    const page = shellPageName(contents.isDestroyed() ? '' : contents.getURL(), devOrigin())
    if (page === undefined) return
    const line = rendererLine(level, page, message, sourceId, lineNumber)
    if (line !== undefined) log.log(line.level, line.text)
  })
}

/**
 * The first thing `boot()` does: starts the log, finds what the last run left, marks this run as running and
 * listens for deaths. Nothing here may throw into the start of the browser.
 */
export function startDiagnostics (runtime: { readonly dir: string, readonly isPrivate: boolean }): void {
  try {
    const started = new DiagnosticsService({
      dir: join(runtime.dir, 'diagnostics'),
      crashDumpsDir: app.getPath('crashDumps'),
      isPrivate: runtime.isPrivate,
      now: Date.now,
      randomBytes: (count) => randomBytes(count),
      pid: process.pid
    })
    service = started
    captureConsole(console, (level, text) => { started.log(level, text) })
    started.begin()
    setCrashLookups({ page: (id) => started.crashOfPage(id)?.id, lastRun: () => started.lastRunCrash()?.id })

    app.on('before-quit', () => { quitting = true })
    // An orderly quit removes the marker; app.exit() and a crash do not reach will-quit, which is how the next start knows.
    app.once('will-quit', () => { started.end() })
    process.once('exit', () => { started.flush() })

    app.on('web-contents-created', (_event, contents) => { attachRendererLog(contents, started) })
    app.on('render-process-gone', (_event, contents, details) => {
      if (isOrdinaryEnd('renderer', details.reason, quitting) || contents.isDestroyed() || takeEndedOnPurpose(contents.id)) return
      const url = contents.getURL()
      started.record({
        kind: 'renderer',
        process: processName({ ...classify(contents), url, devOrigin: devOrigin() }),
        reason: details.reason,
        exitCode: details.exitCode,
        message: `The page process ended: ${details.reason}.`,
        stack: '',
        ...(url === '' || isShellSchemeUrl(url) ? {} : { page: url }),
        webContentsId: contents.id
      })
    })
    app.on('child-process-gone', (_event, details) => {
      if (isOrdinaryEnd('child', details.reason, quitting)) return
      const name = childProcessName({ type: details.type, serviceName: details.serviceName, name: details.name })
      started.record({ kind: 'child-process', process: name, reason: details.reason, exitCode: details.exitCode, message: `The ${name} process ended: ${details.reason}.`, stack: '' })
    })
  } catch (error) {
    console.error('[orivon] diagnostics could not start:', error)
  }
}

/** Called from `start.ts`'s fatal-error handler, on the way out of the process. Never throws. */
export function recordFatal (reason: string, error: unknown): void {
  try {
    service?.recordFatal(reason, error)
  } catch {
    // The process is already ending; a failed record must not hide the error that did it.
  }
}

/**
 * Native crash dumps are collected on this computer and never sent by the crash reporter: a dump leaves only
 * when the person ticks the box on a report. Crashpad must be started before the app is ready.
 */
export const diagnosticsSubsystem: Subsystem = {
  name: 'diagnostics',
  beforeReady: () => {
    crashReporter.start({ productName: 'Orivon', uploadToServer: false })
  }
}
