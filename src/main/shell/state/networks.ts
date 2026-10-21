import type { Dot } from '../../networks/networks-view.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** The dot on the Available networks button: green while a node runs, amber while one starts or syncs, red when one the person switched on failed, none otherwise. Read from memory on every push; nothing is measured. */
export const networksStatePart: ShellStatePart = {
  name: 'networks',
  read: ({ services }): { networksDot: Dot } => ({ networksDot: services.networks.dot() }),
  // A node, a tunnel or a switch reports many changes the toolbar shows nothing of (a tunnel coming up, a peer count): only a different dot is worth a push of the whole state to the window.
  watch: ({ services }, push) => {
    let shown = services.networks.dot()
    return services.networks.onChange(() => {
      const now = services.networks.dot()
      if (now === shown) return
      shown = now
      push()
    })
  }
}
