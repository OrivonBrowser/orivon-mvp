import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../../contracts/index.js'
import {
  APP,
  FS_GRANT,
  OTHER,
  TCP_GRANT,
  never,
  noop,
  rejection,
  spyDestroy,
  table,
  thrown
} from './handles.test-helpers.js'

// Split out of handles.test.ts (code-guidelines.md Rule 2: 800 lines for a
// test file), grown past budget once L5-userselected added the picked-path
// revocation cascade's own suite alongside the pre-existing "FileHandle"
// exception tests -- see that file's own header for the shared T11c/
// revocation-cascade context this whole suite sits inside.

describe('the fs.userSelected exception', () => {
  it('keeps a picker-authorised file open across an fs revocation', async () => {
    const t = table()
    const granted = spyDestroy()
    const picked = spyDestroy()
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: granted })
    const userSelected = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-test' }, destroy: picked })

    await t.revoke(APP, FS_GRANT)

    // The user's one-time choice at the OS picker IS the authorisation. It is
    // not the standing fs grant, so withdrawing that grant cannot withdraw it.
    expect(granted).toHaveBeenCalledWith('revoked')
    expect(picked).not.toHaveBeenCalled()
    expect(t.lookup(APP, userSelected.id).id).toBe(userSelected.id)
  })

  it('still counts a picker-authorised file against the file limit', () => {
    const t = table()
    for (let i = 0; i < LIMITS.concurrentFileHandles; i += 1) {
      t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-test' }, destroy: noop })
    }

    // The exception is to the revocation cascade only. An open fd is an open
    // fd however the user authorised it.
    expect(thrown(() => t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-test' }, destroy: noop })).code).toBe('limit')
  })

  it('does not survive the session', async () => {
    const t = table()
    const picked = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-test' }, destroy: picked })

    await t.dropOrigin(APP)

    // Session-scoped, not a standing grant of its own: it must not come back
    // after a restart, so the session teardown has to take it.
    expect(picked).toHaveBeenCalledWith('sessionEnded')
    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('denied')
  })

  it('closes a picker-authorised file when its OWN pick is revoked, not when fs is', async () => {
    const t = table()
    const picked = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-A' }, destroy: picked })

    // The other half of the exception: `fs`'s revoke cannot reach this
    // handle (proven above), but the settings list's own revoke of the pick
    // itself must -- "WITHOUT THIS CASCADE THE REVOKE BUTTON LIES"
    // (../index.ts's revokePersisted, the same principle applied here).
    await t.revokeUserSelected(APP, 'pick-A')

    expect(picked).toHaveBeenCalledWith('revoked')
    // 'revoked', not 'denied': the id is remembered as revoked, the same
    // answer an ordinary grant revoke's own lookup gives (above).
    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('revoked')
  })

  it('leaves a DIFFERENT pick from the same origin untouched', async () => {
    const t = table()
    const untouched = spyDestroy()
    const revoked = spyDestroy()
    const kept = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-A' }, destroy: untouched })
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-B' }, destroy: revoked })

    await t.revokeUserSelected(APP, 'pick-B')

    expect(revoked).toHaveBeenCalledWith('revoked')
    expect(untouched).not.toHaveBeenCalled()
    expect(t.lookup(APP, kept.id).id).toBe(kept.id)
  })

  it('rejects every promise the app is awaiting on a revoked pick', async () => {
    const t = table()
    const handle = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-A' }, destroy: noop })
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    await t.revokeUserSelected(APP, 'pick-A')

    await expect(pending).rejects.toMatchObject({ code: 'revoked' })
    await expect(handle.closed).rejects.toMatchObject({ code: 'revoked' })
  })

  it('is a silent no-op for a pick id this origin never held, and for an origin with no table at all', async () => {
    const t = table()
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected', pickId: 'pick-A' }, destroy: noop })

    await expect(t.revokeUserSelected(APP, 'never-existed')).resolves.toBeUndefined()
    await expect(t.revokeUserSelected('https://never-loaded.example', 'pick-A')).resolves.toBeUndefined()
  })

  it('closes grant-authorised handles and pending operations on session teardown', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    await t.dropOrigin(APP)

    expect(destroy).toHaveBeenCalledWith('sessionEnded')
    expect((await rejection(pending)).code).toBe('revoked')
    expect(t.counts(APP).handles).toBe(0)
  })

  it('leaves other origins alone on session teardown', async () => {
    const t = table()
    const theirs = spyDestroy()
    t.acquire({ origin: OTHER, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: theirs })

    await t.dropOrigin(APP)

    expect(theirs).not.toHaveBeenCalled()
  })
})
