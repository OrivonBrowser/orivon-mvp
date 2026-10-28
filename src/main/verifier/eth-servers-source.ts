// Where the Ethereum servers come from and whether the host was built with them: the settings are read through `read`, each
// time one is needed, and a change restarts the host only when it changes the servers a request would go to.

import { effectiveEthServers, sameEthServers } from './eth-servers.js'
import type { EthServers } from './eth-servers.js'

export class EthServersSource {
  private read: () => EthServers = () => effectiveEthServers({ choice: 'orivon', rpcs: '', beacon: '' })
  private applied: EthServers | undefined

  /** Until this is called, Orivon's servers. */
  configure (read: () => EthServers): void {
    this.read = read
  }

  /** The servers asked now. */
  current (): EthServers {
    return this.read()
  }

  /** The servers a host is being built with, remembered so that `changed` can tell. */
  forHost (): EthServers {
    this.applied = this.read()
    return this.applied
  }

  /** Whether the servers asked now are not those the host was built with (remembering them). An address typed while Orivon's servers are chosen changes nothing. */
  changed (): boolean {
    const now = this.read()
    if (this.applied !== undefined && sameEthServers(this.applied, now)) return false
    this.applied = now
    return true
  }
}
