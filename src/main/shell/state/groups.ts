import type { ShellStatePart } from '../shell-state-parts.js'
import { groupsFor } from '../../tab-groups/groups-model.js'
import type { TabGroupState } from '../tab-extra-types.js'

/** The window's groups, in the order their first tabs sit in the strip; a group no tab holds is not listed. */
export const groupsStatePart: ShellStatePart = {
  name: 'groups',
  read: ({ window }, { tabs }) => {
    const known = new Map(groupsFor(window.tabs).list().map((group) => [group.id, group]))
    const listed: TabGroupState[] = []
    for (const tab of tabs) {
      const group = tab.group === undefined || tab.group === null ? undefined : known.get(tab.group)
      if (group !== undefined && !listed.includes(group)) listed.push(group)
    }
    return { groups: listed }
  },
  watch: ({ window }, push) => groupsFor(window.tabs).onChange(push)
}
