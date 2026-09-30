// Reads the facts About shows from the running process. Kept apart from
// about-info.ts so the table and its wording need no Electron to test.
import { app, clipboard, session } from 'electron'
import type { SettingsStore } from '../settings/settings-store.js'
import type { AboutFacts } from './about-info.js'
import type { GpuReading } from './about-domain.js'

export function readAboutFacts (settings: Pick<SettingsStore, 'get'>, isPrivate: boolean): AboutFacts {
  const chosenDownloads = settings.get('downloads.folder')
  return {
    orivon: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    language: app.getLocale(),
    userAgent: session.defaultSession.getUserAgent(),
    commandLine: process.argv.join(' '),
    programPath: app.getPath('exe'),
    profilePath: app.getPath('userData'),
    downloadsPath: chosenDownloads !== '' ? chosenDownloads : safeDownloadsPath(),
    isPrivate
  }
}

/** `getPath('downloads')` throws on a machine with no downloads folder configured. */
function safeDownloadsPath (): string {
  try {
    return app.getPath('downloads')
  } catch {
    return 'Not available'
  }
}

export async function readGpu (): Promise<GpuReading> {
  const status: unknown = app.getGPUFeatureStatus()
  // Under a display with no graphics card this rejects, which leaves the feature table standing.
  const info = await app.getGPUInfo('basic').catch(() => undefined)
  return { status, info }
}

export function copyToClipboard (text: string): void {
  clipboard.writeText(text)
}
