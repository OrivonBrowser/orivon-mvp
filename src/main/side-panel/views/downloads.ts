// What is downloading and what finished, newest first. A row opens the finished file, never a dangerous type
// (the service refuses it), and the panel deletes nothing here: the Downloads page owns removing and trashing.
import type { DownloadEntry } from '../../downloads/download-types.js'
import { holds } from '../panel-types.js'
import type { PanelRow, PanelViewDef } from '../panel-types.js'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** `2.1 MB`: binary units, one decimal above plain bytes. */
export function sizeText (bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${String(Math.round(value))} B` : `${value.toFixed(1)} ${UNITS[unit] ?? 'TB'}`
}

const progressText = (entry: DownloadEntry): string =>
  entry.total > 0 ? `${sizeText(entry.received)} of ${sizeText(entry.total)}` : sizeText(entry.received)

/** The state line under a download's name. */
export function stateLine (entry: DownloadEntry): string {
  switch (entry.state) {
    case 'progressing': return progressText(entry)
    case 'paused': return `Paused, ${progressText(entry)}`
    case 'completed': return entry.missing === true ? 'Moved or deleted' : 'Done'
    case 'cancelled': return 'Cancelled'
    case 'interrupted': return 'Failed'
  }
}

function rowOf (entry: DownloadEntry): PanelRow {
  const running = entry.state === 'progressing' || entry.state === 'paused'
  return {
    id: entry.id,
    kind: 'item',
    title: entry.fileName,
    sub: stateLine(entry),
    ...(running ? { progress: entry.total > 0 ? Math.min(1, entry.received / entry.total) : null } : {})
  }
}

export const downloadsView: PanelViewDef = {
  id: 'downloads',
  title: 'Downloads',
  icon: 'downloads',
  searchLabel: 'Search downloads',
  things: 'downloads',
  empty: 'Files you download appear here.',
  page: { label: 'Open downloads page', id: 'downloads' },
  rows: ({ services }, query) => services.downloads.list()
    .filter((entry) => holds(query, entry.fileName))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(rowOf),
  activate: ({ services }, id) => { void services.downloads.open(id) },
  watch: ({ services }, changed) => services.downloads.onChange(changed)
}
