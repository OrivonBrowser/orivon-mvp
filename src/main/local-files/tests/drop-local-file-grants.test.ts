import { describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import { dropLocalFileGrants } from '../drop-local-file-grants.js'

const KEY = 'file:///home/u/notes/app.html'

function broker (persisted: Record<string, unknown>, picks: Record<string, unknown> = {}): { broker: Broker, revokePersisted: ReturnType<typeof vi.fn>, revokeUserSelectedPath: ReturnType<typeof vi.fn>, clearDeclinedConsent: ReturnType<typeof vi.fn> } {
  const revokePersisted = vi.fn(async () => true)
  const revokeUserSelectedPath = vi.fn(async () => true)
  const clearDeclinedConsent = vi.fn(async () => {})
  return {
    broker: { revokePersisted, revokeUserSelectedPath, clearDeclinedConsent, app: { persistedAppsSync: () => [{ origin: KEY, appName: 'Notes', grants: persisted, pickedPaths: picks }, { origin: 'file:///other.html', appName: 'Other', grants: { fs: {} }, pickedPaths: {} }] } } as unknown as Broker,
    revokePersisted, revokeUserSelectedPath, clearDeclinedConsent
  }
}

describe('dropLocalFileGrants', () => {
  it('revokes every persisted grant and pick of that key only, and forgets its declined consent', async () => {
    const r = broker({ fs: {}, id: {} }, { p1: {} })
    await dropLocalFileGrants(r.broker, KEY)
    expect(r.revokePersisted.mock.calls).toEqual([[KEY, 'fs'], [KEY, 'id']])
    expect(r.revokeUserSelectedPath).toHaveBeenCalledWith(KEY, 'p1')
    expect(r.clearDeclinedConsent).toHaveBeenCalledWith(KEY)
  })

  it('still forgets the declined consent for a key with nothing persisted', async () => {
    const r = broker({})
    await dropLocalFileGrants(r.broker, 'file:///nothing.html')
    expect(r.revokePersisted).not.toHaveBeenCalled()
    expect(r.clearDeclinedConsent).toHaveBeenCalledWith('file:///nothing.html')
  })
})
