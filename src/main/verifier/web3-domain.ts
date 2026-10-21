// What the Settings page may ask about the Ethereum light client: how it is
// doing, in words, and whether it is switched on. The switch applies at once.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { LightClientView } from './status-view.js'

export interface Web3Deps {
  readonly view: () => LightClientView
  /** What the person has chosen now. */
  readonly enabled: () => boolean
  /** Switched off from outside the browser, whatever is chosen here. */
  readonly forcedOff: () => boolean
}

export function web3Domain (deps: Web3Deps): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'status') return undefined
      return { view: deps.view(), enabled: deps.enabled(), forcedOff: deps.forcedOff() }
    }
  }
}
