import { describe, expect, it } from 'vitest'
import {
  clearPendingInstalled, INSTALLED_DETAILS_TTL_MS, registerPendingInstalled, takePendingInstalled
} from '../runtime-installed.js'
import { runtimeApi } from '../api/runtime-api.js'
import { EXT, fakeContext } from '../api/tests/api-fixtures.js'

describe('the pending install details', () => {
  it('are handed over once, then gone: a restarted worker gets none', () => {
    registerPendingInstalled('a', { reason: 'update', previousVersion: '1.0.0' }, 1000)
    expect(takePendingInstalled('a', 1001)).toEqual({ reason: 'update', previousVersion: '1.0.0' })
    expect(takePendingInstalled('a', 1002)).toBeUndefined()
  })

  it('belong to one extension', () => {
    registerPendingInstalled('a', { reason: 'install' }, 1000)
    expect(takePendingInstalled('b', 1001)).toBeUndefined()
    expect(takePendingInstalled('a', 1001)).toEqual({ reason: 'install' })
  })

  it('expire when no worker asks in time', () => {
    registerPendingInstalled('a', { reason: 'install' }, 1000)
    expect(takePendingInstalled('a', 1000 + INSTALLED_DETAILS_TTL_MS + 1)).toBeUndefined()
  })

  it('can be cleared by a failed install', () => {
    registerPendingInstalled('a', { reason: 'install' }, 1000)
    clearPendingInstalled('a')
    expect(takePendingInstalled('a', 1001)).toBeUndefined()
  })
})

describe('runtime.takeInstalled', () => {
  it('answers the caller\'s own parked details once, then null', async () => {
    const { ctx, call } = fakeContext({})
    runtimeApi.install(ctx)
    registerPendingInstalled(EXT, { reason: 'install' })
    expect(await call('runtime.takeInstalled')).toEqual({ reason: 'install' })
    expect(await call('runtime.takeInstalled')).toBeNull()
  })
})
