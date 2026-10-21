import type { ScoreLevel } from '../../../trust/website-level.js'

/** The level of the site whose mark opened the card; `unscored` is a Level 2 no provider has judged (Web?). */
export interface ThisSite { level: ScoreLevel, unscored: boolean }

/** What main's show reply carries: `{ site }`, absent when the shield was pressed on a new tab and no site is open. */
export function thisSiteOf (reply: unknown): ThisSite | null {
  const site = typeof reply === 'object' && reply !== null ? (reply as { site?: unknown }).site : undefined
  if (typeof site !== 'object' || site === null) return null
  const { level, unscored } = site as { level?: unknown, unscored?: unknown }
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return null
  return { level, unscored: level === 2 && unscored === true }
}
