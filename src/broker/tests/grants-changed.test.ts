import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'
import type { PickPathResult } from '../broker-contracts.js'

// `onGrantsChanged` (grant-events.ts) is the Settings Apps list's live-update
// source: every surface that grants or revokes goes through one of these
// four broker methods, so hooking them is the whole mechanism (start-
// internal-pages.ts's own header on this). Each test below is the same
// shape as this method's own existing behavioural suite (grant-widening.test.ts,
// user-selected.test.ts): call the real method through a real createBroker,
// and check the one new effect it now also has.

function pickedDirectory (path: string): () => Promise<PickPathResult> {
  return async () => ({ canceled: false, paths: [path] })
}

describe('Broker.onGrantsChanged', () => {
  it('fires with the origin after grant()', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    const seen: string[] = []
    broker.onGrantsChanged((origin) => { seen.push(origin) })

    await broker.grant(APP, 'tcp.connect', ['a.example:443'])

    expect(seen).toEqual([APP])
  })

  it('fires after revoke()', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    const granted = await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const seen: string[] = []
    broker.onGrantsChanged((origin) => { seen.push(origin) })

    await broker.revoke(APP, granted.id)

    expect(seen).toEqual([APP])
  })

  it('fires after revokePersisted() actually removes something, never when there was nothing to remove', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const seen: string[] = []
    broker.onGrantsChanged((origin) => { seen.push(origin) })

    expect(await broker.revokePersisted(APP, 'tcp.connect')).toBe(true)
    expect(await broker.revokePersisted(APP, 'tcp.connect')).toBe(false)

    expect(seen).toEqual([APP])
  })

  it('fires after revokeUserSelectedPath() removes a pick', async () => {
    const broker = createBroker(baseDeps({ pickPath: pickedDirectory('/home/user/Downloads') }))
    broker.registerApp(APP, manifestWith({}))
    await broker.fs.userSelected(APP, { directory: true })
    const [pick] = await broker.app.pickedPaths(APP)
    const seen: string[] = []
    broker.onGrantsChanged((origin) => { seen.push(origin) })

    await broker.revokeUserSelectedPath(APP, pick!.id)

    expect(seen).toEqual([APP])
  })

  it('stops firing once the listener unsubscribes', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    let calls = 0
    const off = broker.onGrantsChanged(() => { calls += 1 })
    off()

    await broker.grant(APP, 'tcp.connect', ['a.example:443'])

    expect(calls).toBe(0)
  })
})
