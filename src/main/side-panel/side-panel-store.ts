// What the panel remembers between runs: its width and the last view it showed, in <userData>/side-panel.json.
// A private session uses the memory store and writes no file. Read once, synchronously: the file is a few bytes
// and the first window needs the width before it lays out.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from './side-panel-model.js'

const FILE_VERSION = 1
const WRITE_DELAY_MS = 400
export const DEFAULT_VIEW = 'bookmarks'
const VIEW_ID = /^[a-z][a-z0-9-]{0,31}$/

export interface PanelPrefs { width: number, view: string }

export interface SidePanelStore {
  get: () => PanelPrefs
  set: (patch: Partial<PanelPrefs>) => void
  flush: () => Promise<void>
}

/** The prefs out of a parsed file; anything that is not what this version wrote falls back to the default. */
export function parsePrefs (parsed: unknown): PanelPrefs {
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  if (record['version'] !== FILE_VERSION) return { width: PANEL_DEFAULT, view: DEFAULT_VIEW }
  const { width, view } = record
  return {
    width: typeof width === 'number' && Number.isFinite(width) ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width))) : PANEL_DEFAULT,
    view: typeof view === 'string' && VIEW_ID.test(view) ? view : DEFAULT_VIEW
  }
}

export class MemorySidePanelStore implements SidePanelStore {
  private prefs: PanelPrefs = { width: PANEL_DEFAULT, view: DEFAULT_VIEW }

  get (): PanelPrefs { return this.prefs }
  set (patch: Partial<PanelPrefs>): void { this.prefs = parsePrefs({ version: FILE_VERSION, ...this.prefs, ...patch }) }
  async flush (): Promise<void> {}
}

export class FileSidePanelStore implements SidePanelStore {
  private prefs: PanelPrefs
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() }, WRITE_DELAY_MS)

  constructor (private readonly filePath: string) {
    this.prefs = this.read()
  }

  get (): PanelPrefs { return this.prefs }

  set (patch: Partial<PanelPrefs>): void {
    const next = parsePrefs({ version: FILE_VERSION, ...this.prefs, ...patch })
    if (next.width === this.prefs.width && next.view === this.prefs.view) return
    this.prefs = next
    this.writer.schedule()
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private read (): PanelPrefs {
    try {
      return parsePrefs(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] the side panel file is unreadable, using its defaults:', error)
      return parsePrefs(null)
    }
  }

  private writeNow (): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, ...this.prefs }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist the side panel:', error)
      throw error
    }
  }
}
