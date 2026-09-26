import { describe, expect, it } from 'vitest'
import { dispatchApp } from '../app.js'
import type { AppControlMethod } from '../app.js'
import { dispatchFs } from '../fs.js'
import type { FsControlMethod } from '../fs.js'
import { dispatchId } from '../id.js'
import type { IdControlMethod } from '../id.js'
import { dispatchWeb } from '../web.js'
import type { WebControlMethod } from '../web.js'
import { APP, stubBroker } from '../../tests/ipc.test-helpers.js'

// The exhaustiveness guard added to transport/dispatch/{fs,app,id}.ts,
// closing the class A185 found in net.listen: a ControlMethod member with no
// matching switch case must not silently resolve `undefined` -- a reported
// success for an operation that never ran. ../../ipc.ts's own dispatch() and
// ../net.ts's dispatchNet already had this guard; this file is its
// regression test for the three siblings.
//
// `ipc.ts`'s own `isControlMethod` gate means no REAL caller can reach an
// unrouted method through the normal request path -- the scenario this
// guards against is a FUTURE ControlMethod union member landing with no
// switch case to match it, which is exactly what a type-level `never` check
// cannot stop a caller from doing at runtime. The cast below reproduces
// that exact shape directly against each exported dispatcher.
const UNROUTED = 'nonexistent.method'

describe('dispatchFs/dispatchApp/dispatchId fail closed on an unrouted method, instead of silently resolving undefined (A185\'s class)', () => {
  it('dispatchFs throws internal rather than resolving undefined -- fails against the unfixed code (no default case), which resolves undefined', async () => {
    const broker = stubBroker([])

    await expect(dispatchFs(broker, APP, UNROUTED as unknown as FsControlMethod, {}))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('dispatchApp throws internal rather than resolving undefined -- fails against the unfixed code (no default case), which resolves undefined', async () => {
    const broker = stubBroker([])

    await expect(dispatchApp(broker, APP, UNROUTED as unknown as AppControlMethod, {}, undefined))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('dispatchId throws internal rather than resolving undefined -- fails against the unfixed code (no default case), which resolves undefined', async () => {
    const broker = stubBroker([])

    await expect(dispatchId(broker, APP, UNROUTED as unknown as IdControlMethod, {}))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('dispatchWeb throws internal rather than resolving undefined -- fails against the unfixed code (no default case), which resolves undefined', async () => {
    const broker = stubBroker([])

    await expect(dispatchWeb(broker, APP, UNROUTED as unknown as WebControlMethod, {}))
      .rejects.toMatchObject({ code: 'internal' })
  })
})
