import { onEntryChange } from '../../app-setup/entry-changes.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** Adds no field: it pushes the state when an app's permissions change, so the chrome asks again whether the key wears its dot. */
export const entryChangesStatePart: ShellStatePart = {
  name: 'entryChanges',
  read: () => ({}),
  watch: (_ctx, push) => onEntryChange(push)
}
