import type { TabGroupState } from './groups-model.js'

/** How a native menu names a group: its title, or "Untitled Group" with its colour, which is all that tells two apart. */
export function groupLabel (group: Pick<TabGroupState, 'title' | 'color'>): string {
  if (group.title !== '') return group.title
  return `Untitled Group (${group.color.charAt(0).toUpperCase()}${group.color.slice(1)})`
}
