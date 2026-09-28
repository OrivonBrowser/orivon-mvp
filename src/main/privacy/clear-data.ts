// "Clear browsing data": what is forgotten and how far back. History goes back
// as far as the person chose; the browser's stored site data and cache cannot
// be limited by time, so they are all or nothing. An app's own storage is kept
// apart: apps keep their working data there, so it is only cleared when asked
// for by name.
import type { Session } from 'electron'
import type { HistoryService } from '../history/history-service.js'
import type { ZoomStore } from '../zoom/zoom-store.js'

export const HISTORY_RANGES = ['none', 'hour', 'day', 'week', 'all'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

export interface ClearRequest {
  readonly history: HistoryRange
  /** Cookies and the storage sites keep in the browser, for every ordinary website. */
  readonly siteData: boolean
  readonly cache: boolean
  readonly zoomLevels: boolean
  /** The browser storage of every app that holds permissions. */
  readonly appData: boolean
}

export interface ClearResult {
  readonly ok: boolean
  /** What could not be cleared, by the name the page uses for it. */
  readonly failed: readonly string[]
}

export interface ClearDeps {
  readonly history: Pick<HistoryService, 'removeRange' | 'clear'>
  readonly zoom: Pick<ZoomStore, 'clear'>
  /** The session ordinary websites run in. */
  readonly websites: Pick<Session, 'clearData'>
  /** The session of each app that holds permissions. */
  readonly appSessions: () => Promise<ReadonlyArray<Pick<Session, 'clearData'>>>
  readonly now: () => number
}

const RANGE_MS: Record<'hour' | 'day' | 'week', number> = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 }
const SITE_DATA = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'webSQL', 'fileSystems', 'backgroundFetch'] as const

/** The request a page sent, or null when it is not one. */
export function parseClearRequest (value: unknown): ClearRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { history, siteData, cache, zoomLevels, appData } = value as Record<string, unknown>
  if (!(HISTORY_RANGES as readonly unknown[]).includes(history)) return null
  if (![siteData, cache, zoomLevels, appData].every((flag) => typeof flag === 'boolean')) return null
  return { history: history as HistoryRange, siteData: siteData as boolean, cache: cache as boolean, zoomLevels: zoomLevels as boolean, appData: appData as boolean }
}

export async function clearBrowsingData (request: ClearRequest, deps: ClearDeps): Promise<ClearResult> {
  const failed: string[] = []
  const attempt = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      console.error(`[orivon] clearing ${name} failed:`, error)
      failed.push(name)
    }
  }

  if (request.history === 'all') await attempt('history', () => { deps.history.clear() })
  else if (request.history !== 'none') await attempt('history', () => { deps.history.removeRange(deps.now() - RANGE_MS[request.history as 'hour' | 'day' | 'week'], deps.now()) })
  if (request.siteData) await attempt('siteData', async () => { await deps.websites.clearData({ dataTypes: [...SITE_DATA] }) })
  if (request.cache) await attempt('cache', async () => { await deps.websites.clearData({ dataTypes: ['cache'] }) })
  if (request.zoomLevels) await attempt('zoomLevels', () => { deps.zoom.clear() })
  if (request.appData) {
    await attempt('appData', async () => {
      for (const session of await deps.appSessions()) await session.clearData()
    })
  }
  return { ok: failed.length === 0, failed }
}
