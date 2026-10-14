// The Nym tunnel as the Available networks popup reads it. The routes are published by a subsystem, so a read or a
// subscription can come before them; a subscription made then would call nothing for ever. This source holds its
// listeners itself and joins the routes' Nym on the first read or subscription that finds them.

import type { SubsystemContext } from '../registry.js'
import type { NetworksEnv } from './networks-source.js'

export function nymSourceFor (ctx: Pick<SubsystemContext, 'routes'>): NetworksEnv['nym'] {
  const listeners = new Set<() => void>()
  let leave: (() => void) | undefined

  /** The routes' Nym, joining its changes the first time it is found. A join made by a read tells the listeners: what they last read may predate it. */
  function nym (announce: boolean) {
    const routes = ctx.routes
    if (routes === undefined) return undefined
    if (leave === undefined && listeners.size > 0) {
      leave = routes.nym.onChange(() => { for (const listener of [...listeners]) listener() })
      if (announce) for (const listener of [...listeners]) listener()
    }
    return routes.nym
  }

  return {
    state: () => nym(true)?.state() ?? { state: 'off' },
    tunnels: () => nym(true)?.tunnels() ?? { connecting: 0, ready: 0 },
    processInfo: () => nym(true)?.processInfo(),
    onChange: (listener) => {
      listeners.add(listener)
      nym(false)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) { leave?.(); leave = undefined }
      }
    }
  }
}
