import { describe, expect, it } from 'vitest'
import type { Pattern } from '../../../contracts/index.js'
import { APP, TCP_GRANT, noop, outcomeNow, rejection, spyDestroy, table } from './handles.test-helpers.js'

// HandleTable.replaceGrant: one grant for a capability replaced by another.
// A live handle the new grant still covers is re-filed under it and keeps
// running; only what the new grant no longer covers is revoked.

const NEW = 'grant-tcp-connect-2'
const coveredBy = (host: string) => (patterns: readonly Pattern[]): boolean => patterns.includes(`${host}:443`)

describe('replacing a grant with one that covers everything it did', () => {
  it('keeps every handle, and revoking the NEW grant is what closes them', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['a.example:443', 'b.example:443'], true)
    expect(destroy).not.toHaveBeenCalled()
    expect((await outcomeNow(handle.closed)).state).toBe('pending')

    await t.revoke(APP, NEW)
    expect(destroy).toHaveBeenCalledWith('revoked')
  })

  it('an acquisition in flight under the old grant registers under the new one', async () => {
    const t = table()
    let finish!: () => void
    const acquired = t.run(APP, { on: 'grant', grantId: TCP_GRANT }, async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })
    })

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['*:*'], true)
    finish()
    const handle = await acquired
    await t.revoke(APP, NEW)

    expect((await rejection(handle.closed)).code).toBe('revoked')
  })

  it('revoking the new grant also cancels an operation still scoped to the old one', async () => {
    const t = table()
    const pending = t.run(APP, { on: 'grant', grantId: TCP_GRANT }, async () => await new Promise<never>(() => {}))

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['*:*'], true)
    expect((await outcomeNow(pending)).state).toBe('pending')
    await t.revoke(APP, NEW)

    expect((await rejection(pending)).code).toBe('revoked')
  })
})

describe('replacing a grant with one that covers only part of it', () => {
  it('keeps a handle the new patterns still cover, and revokes one they do not', async () => {
    const t = table()
    const keptDestroy = spyDestroy()
    const droppedDestroy = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: keptDestroy, stillCovered: coveredBy('b.example') })
    const dropped = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: droppedDestroy, stillCovered: coveredBy('a.example') })

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['b.example:443', 'c.example:443'], false)

    expect(keptDestroy).not.toHaveBeenCalled()
    expect(droppedDestroy).toHaveBeenCalledWith('revoked')
    expect((await rejection(dropped.closed)).code).toBe('revoked')
  })

  it('revokes a handle that cannot say whether it is covered', async () => {
    const t = table()
    const destroy = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['b.example:443'], false)

    expect(destroy).toHaveBeenCalledWith('revoked')
  })

  it('cancels an acquisition still in flight, which has nothing yet to judge', async () => {
    const t = table()
    const pending = t.run(APP, { on: 'grant', grantId: TCP_GRANT }, async () => await new Promise<never>(() => {}))

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['b.example:443'], false)

    expect((await rejection(pending)).code).toBe('revoked')
  })

  it('a kept server keeps the connections it accepted', async () => {
    const t = table()
    const childDestroy = spyDestroy()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop, stillCovered: () => true })
    t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: childDestroy })

    await t.replaceGrant(APP, TCP_GRANT, NEW, ['6881-6889'], false)
    expect(childDestroy).not.toHaveBeenCalled()

    await t.revoke(APP, NEW)
    expect(childDestroy).toHaveBeenCalledWith('revoked')
  })
})
