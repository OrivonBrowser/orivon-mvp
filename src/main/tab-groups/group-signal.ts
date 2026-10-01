import type { TabSignal } from '../shell/tab-signals.js'

/** A tab's group, as the chrome and the extension host read it. */
export const groupSignal: TabSignal = {
  name: 'group',
  state: (record) => ({ group: record.groupId ?? null })
}
