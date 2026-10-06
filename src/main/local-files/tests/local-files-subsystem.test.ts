import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  fuseReads: 0,
  onSessionCreated: undefined as undefined | ((created: unknown) => void)
}))

const fakeSession = (): { protocol: { isProtocolHandled: () => boolean, handle: () => void, unhandle: () => void }, fetch: () => void } => ({
  protocol: { isProtocolHandled: () => false, handle: vi.fn(), unhandle: vi.fn() },
  fetch: vi.fn()
})

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orivon-subsystem-test',
    on: (event: string, listener: (created: unknown) => void) => { if (event === 'session-created') state.onSessionCreated = listener }
  },
  session: { defaultSession: fakeSession(), fromPartition: () => fakeSession() }
}))
vi.mock('../file-fuse.js', () => ({
  fileProtocolFuse: () => { state.fuseReads += 1; return Promise.resolve('off') },
  knownFileProtocolFuse: () => undefined
}))
vi.mock('../../../loader/electron/serve.js', () => ({ liveCspHeaderFor: vi.fn() }))
vi.mock('../../sessions/web-request-owner.js', () => ({ webRequestOwnerFor: () => ({ onBeforeRequest: vi.fn() }) }))

const { localFilesSubsystem } = await import('../local-files-subsystem.js')

beforeEach(() => { state.fuseReads = 0 })

describe('the local-files subsystem and the binary\'s fuse', () => {
  it('reads the binary at no point of start-up: only the first local file asks', async () => {
    await localFilesSubsystem.beforeReady?.()
    await localFilesSubsystem.afterReady?.({ broker: undefined } as never)
    expect(state.fuseReads).toBe(0)
  })
})
