import type { Dot } from '../../networks/networks-view.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** The dot on the Available networks button: green while a node runs, amber while one starts or syncs, red when one the person switched on failed, none otherwise. Read from memory on every push; nothing is measured. */
export const networksStatePart: ShellStatePart = {
  name: 'networks',
  read: ({ services }): { networksDot: Dot } => ({ networksDot: services.networks.dot() }),
  watch: ({ services }, push) => services.networks.onChange(push)
}
