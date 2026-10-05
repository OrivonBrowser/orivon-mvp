// What `chrome.sidePanel.setPanelBehavior` chose, kept in the extension's slot so it outlives a restart.
// Everything else an extension sets for its panel is held in memory and set again by the extension at start.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'

const FILE = 'side-panel-behavior.json'

export function behaviorPath (slotDir: string): string {
  return join(slotDir, FILE)
}

/** Whether the toolbar button opens the panel; false when nothing was saved or the file cannot be read. */
export function readOpenOnActionClick (slotDir: string): boolean {
  try {
    const path = behaviorPath(slotDir)
    if (!existsSync(path)) return false
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as { openPanelOnActionClick?: unknown }).openPanelOnActionClick === true
  } catch {
    return false
  }
}

export function writeOpenOnActionClick (slotDir: string, value: boolean): void {
  try {
    writeFileAtomic(behaviorPath(slotDir), JSON.stringify({ openPanelOnActionClick: value }))
  } catch (error) {
    console.error('[extensions] could not save the side panel behaviour:', error)
  }
}

/** An uninstall leaves nothing that a reinstall into the same slot could inherit. */
export function clearOpenOnActionClick (slotDir: string): void {
  rmSync(behaviorPath(slotDir), { force: true })
}
