// <userData>/update-check-state.json: when the release source was last reached and which version the person was last asked about.
import { readFile, writeFile } from 'node:fs/promises'
import type { CheckerState } from './update-checker.js'

/** A missing file (first run) or corrupt JSON both read back as "never checked": fail safe, never throw. */
export async function readUpdateState (path: string): Promise<CheckerState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { lastCheckedAt, lastNotifiedVersion } = parsed as Record<string, unknown>
    return {
      ...(typeof lastCheckedAt === 'number' ? { lastCheckedAt } : {}),
      ...(typeof lastNotifiedVersion === 'string' ? { lastNotifiedVersion } : {})
    }
  } catch {
    return {}
  }
}

/** Best effort: losing this write only costs one extra look next start. */
export async function writeUpdateState (path: string, state: CheckerState): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(state), 'utf8')
  } catch (error) {
    console.error('[orivon] update-check: failed to persist state:', error)
  }
}
