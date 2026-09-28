import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { FsTransport } from '../dispatch/fs.js'
import { createPortRegistry } from '../relay/port-registry.js'
import { createBroker } from '../../index.js'
import type { Broker } from '../../broker-contracts.js'
import { APP, baseDeps, manifestWith, stubFs } from '../../tests/index.test-helpers.js'
import { envelope, frameFor, OTHER } from './ipc.test-helpers.js'

// An operation on a file handle that has ended reaches the page as what
// actually happened to it -- 'closed' with EBADF, or 'revoked' -- not as the
// 'denied' an id the origin never held gets. Through the real broker, since
// the registry entry is gone by then and only the handle table remembers.

async function fsBroker (): Promise<Broker> {
  const broker = createBroker(baseDeps({ fs: stubFs({ files: new Map([['/apps/app/a.bin', new Uint8Array([1, 2, 3])]]) }) }))
  await broker.registerApp(APP, manifestWith({ fs: {} }))
  await broker.grant(APP, 'fs', [])
  return broker
}

async function call (broker: Broker, transport: FsTransport, method: string, payload: unknown, origin = APP): Promise<unknown> {
  return await handleControlRequest(broker, frameFor(origin), envelope(method, payload), undefined, undefined, undefined, transport)
}

async function openA (broker: Broker, transport: FsTransport): Promise<string> {
  const opened = await call(broker, transport, 'fs.open', { path: 'a.bin', flags: 'r+' }) as { ok: true, result: { id: string } }
  return opened.result.id
}

describe('fs.* on a handle that has ended', () => {
  it('answers closed with EBADF once the app closed it', async () => {
    const broker = await fsBroker()
    const transport: FsTransport = { registry: createPortRegistry() }
    const id = await openA(broker, transport)
    await call(broker, transport, 'fs.close', { id })

    const response = await call(broker, transport, 'fs.read', { id, position: 0, length: 1 })

    expect(response).toMatchObject({ ok: false, code: 'closed', platformCode: 'EBADF' })
  })

  it('answers revoked once the fs grant was withdrawn', async () => {
    const broker = await fsBroker()
    const transport: FsTransport = { registry: createPortRegistry() }
    const id = await openA(broker, transport)
    const [grant] = await broker.app.grants(APP)
    await broker.revoke(APP, grant!.id)

    const response = await call(broker, transport, 'fs.write', { id, position: 0, data: new Uint8Array([9]) })

    expect(response).toMatchObject({ ok: false, code: 'revoked' })
  })

  it('stays denied for an id another origin held, and for one never issued', async () => {
    const broker = await fsBroker()
    const transport: FsTransport = { registry: createPortRegistry() }
    const id = await openA(broker, transport)
    await call(broker, transport, 'fs.close', { id })

    expect(await call(broker, transport, 'fs.fstat', { id }, OTHER)).toMatchObject({ ok: false, code: 'denied' })
    expect(await call(broker, transport, 'fs.fstat', { id: 'never-issued' })).toMatchObject({ ok: false, code: 'denied' })
  })
})
