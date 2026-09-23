import { describe, expect, it } from 'vitest'
import { APP, OTHER, TCP_GRANT, acquireSocket, rejection, table, thrown } from './handles.test-helpers.js'

// What an operation on a handle that is no longer live reports to its OWNER:
// 'closed' with a Node-mappable EBADF when the owner closed it (or it died),
// 'revoked' when its grant was withdrawn -- never the 'denied' an id the
// origin never held gets, and never one mistaken for the other.

describe('an operation on a handle that has ended', () => {
  it('reports closed, with EBADF, once the owner has closed it', async () => {
    const t = table()
    const handle = acquireSocket(t)
    await t.release(APP, handle.id)

    const error = thrown(() => t.lookup(APP, handle.id))

    expect(error.code).toBe('closed')
    expect(error.platformCode).toBe('EBADF')
  })

  it('reports revoked, not closed, once its grant was withdrawn', async () => {
    const t = table()
    const handle = acquireSocket(t)
    await t.revoke(APP, TCP_GRANT)

    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('revoked')
    expect((await rejection(t.run(APP, { on: 'handle', handleId: handle.id }, async () => 'late'))).code).toBe('revoked')
  })

  it('reports closed for a handle that died on its own', () => {
    const t = table()
    const handle = acquireSocket(t)
    t.fail(APP, handle.id, 'reset', 'ECONNRESET')

    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('closed')
  })

  it('stays denied for every other origin, whichever way it ended', async () => {
    const t = table()
    const closed = acquireSocket(t)
    const revoked = acquireSocket(t, APP, 'grant-other')
    await t.release(APP, closed.id)
    await t.revoke(APP, 'grant-other')

    expect(thrown(() => t.lookup(OTHER, closed.id)).code).toBe('denied')
    expect(thrown(() => t.lookup(OTHER, revoked.id)).code).toBe('denied')
  })
})
