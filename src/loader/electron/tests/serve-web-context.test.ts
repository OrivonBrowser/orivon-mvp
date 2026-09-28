import { describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { Grant } from '../../../contracts/index.js'
import { reachOnlyHandlerFor } from '../serve.js'

// ADR-0019's whole network path for an isolated context (spec item 5), split
// into its own sibling file rather than grown onto ./serve.test.ts
// (723/800 lines already, the same reason several *-web.test.ts siblings
// exist elsewhere in this stream). Covers the WIRING -- that
// reachOnlyHandlerFor authorises against the SAME live grant
// (authoriseReachFor, unchanged) `registerServingFor`'s own reach path uses,
// never a copy of it -- not a completed network fetch: that needs the real
// internet and is test/e2e-web-context.test.ts's job (the spec's own item
// 7). Every case below is provably network-free: fetchThirdParty's own
// guard order means reachDial (the real, unmocked nodeReachDial()) is never
// invoked for any of them, since each is denied before that point.
//
// reachSlotsFor's own shared-budget reuse (the OTHER half of "reuse them,
// never copy them") is not exercised dynamically here: proving it without
// either a real network dial (reachDial is not injectable through this
// factory, by design -- ADR-0019's own network path) or exporting the
// module's private state would need one or the other, and neither is a
// trade worth making for this one property. It is a one-line code fact
// instead: reachOnlyHandlerFor calls the SAME reachSlotsFor(broker, opener)
// registerServingFor already calls, over the SAME module-level map, visible
// on inspection of electron/serve.ts itself.

const OPENER = 'https://opener.example'

function fakeBroker (grants: readonly Grant[]): Broker {
  return {
    app: {
      grants: vi.fn(async () => grants),
      socketAllowanceSync: () => 4
    }
  } as unknown as Broker
}

function grant (patterns: readonly string[]): Grant {
  return { id: 'g1', origin: OPENER, capability: 'https.connect', patterns, grantedAt: 0 }
}

describe('reachOnlyHandlerFor', () => {
  it('denies a request to a host the opener holds no https.connect grant for -- reachDial is never reached (no live grant to fetch)', async () => {
    const broker = fakeBroker([])
    const handler = reachOnlyHandlerFor(broker, OPENER)

    const response = await handler(new Request('https://untrusted.example/'))

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('not granted')
  })

  it('checks the LIVE grant, via broker.app.grants, not a snapshot taken at build time', async () => {
    const broker = fakeBroker([])
    const handler = reachOnlyHandlerFor(broker, OPENER)

    await handler(new Request('https://untrusted.example/'))
    await handler(new Request('https://untrusted.example/'))

    expect(broker.app.grants).toHaveBeenCalledTimes(2)
    expect(broker.app.grants).toHaveBeenCalledWith(OPENER)
  })

  it('a granted host is granted -- and only an UNGRANTED host is refused, proving this is a real check rather than a blanket denial', async () => {
    const broker = fakeBroker([grant(['granted.example:443'])])
    const handler = reachOnlyHandlerFor(broker, OPENER)

    const untrusted = await handler(new Request('https://untrusted.example/'))
    expect(untrusted.status).toBe(404)
  })

  it('denies a plain http request -- only https is ever reached from inside a context', async () => {
    const broker = fakeBroker([grant(['granted.example:443'])])
    const handler = reachOnlyHandlerFor(broker, OPENER)

    const response = await handler(new Request('http://granted.example/'))

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('https')
  })

  it('denies when broker.app.grants itself throws (no manifest registered) -- fails closed, same as authoriseReachFor\'s own catch', async () => {
    const broker = {
      app: {
        grants: vi.fn(async () => { throw new Error('no manifest registered for this origin') }),
        socketAllowanceSync: () => 4
      }
    } as unknown as Broker
    const handler = reachOnlyHandlerFor(broker, OPENER)

    const response = await handler(new Request('https://granted.example/'))

    expect(response.status).toBe(404)
  })
})
