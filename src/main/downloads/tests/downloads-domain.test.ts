import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import type { InternalPageId } from '../../pages/internal-pages.js'
import { downloadsDomain } from '../downloads-domain.js'
import type { DownloadsHost } from '../downloads-domain.js'
import type { DownloadService } from '../download-service.js'

function setup () {
  const service = {
    list: vi.fn(() => [{ id: 'a' }]),
    pause: vi.fn(() => true), resume: vi.fn(() => true), cancel: vi.fn(() => true), retry: vi.fn(() => true), remove: vi.fn(() => true),
    keep: vi.fn(() => true), discard: vi.fn(() => true),
    showInFolder: vi.fn(() => true), open: vi.fn(async () => false), deleteFile: vi.fn(async () => true), clear: vi.fn()
  }
  const host: DownloadsHost = {
    isPrivate: false,
    folder: () => '/dl',
    isCustomFolder: () => true,
    openFolder: vi.fn(async () => {}),
    chooseFolder: vi.fn(async () => true),
    resetFolder: vi.fn()
  }
  const domain = downloadsDomain(service as unknown as DownloadService, host)
  const call = async (page: InternalPageId, command: unknown): Promise<unknown> =>
    await domain.handle(command, { page, contents: {} as WebContents } satisfies InternalCaller)
  return { service, host, call, domain }
}

describe('the downloads domain', () => {
  it('is for the Downloads and Settings pages', () => {
    expect(setup().domain.pages).toEqual(['downloads', 'settings'])
  })

  it('lists the entries with the folder and whether this is a private window', async () => {
    const { call } = setup()
    expect(await call('downloads', { type: 'list' })).toEqual({ entries: [{ id: 'a' }], folder: '/dl', private: false })
  })

  it.each(['pause', 'resume', 'cancel', 'retry', 'remove', 'keep', 'discard', 'showInFolder', 'open', 'deleteFile'])('runs %s on the id it is given', async (type) => {
    const { call, service } = setup()
    await call('downloads', { type, id: 'abc' })
    expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[type]).toHaveBeenCalledWith('abc')
  })

  it('answers with what the service said', async () => {
    const { call } = setup()
    expect(await call('downloads', { type: 'open', id: 'abc' })).toEqual({ ok: false })
    expect(await call('downloads', { type: 'pause', id: 'abc' })).toEqual({ ok: true })
  })

  it.each([undefined, null, 5, {}, { type: 'pause' }, { type: 'pause', id: 5 }, { type: 'pause', id: '' }, { type: 'pause', id: 'x'.repeat(65) }, { type: 'pause', id: ['a'] }])('refuses a request of the wrong shape: %j', async (command) => {
    const { call, service } = setup()
    const reply = await call('downloads', command)
    expect(reply === undefined || (reply as { ok: boolean }).ok === false).toBe(true)
    for (const name of ['pause', 'resume', 'cancel', 'retry', 'remove', 'showInFolder', 'open', 'deleteFile']) {
      expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]).not.toHaveBeenCalled()
    }
  })

  it('does not treat a type that is on Object.prototype as a command', async () => {
    const { call } = setup()
    expect(await call('downloads', { type: 'constructor', id: 'a' })).toBeUndefined()
    expect(await call('downloads', { type: 'toString', id: 'a' })).toBeUndefined()
  })

  it('clears the list and opens the folder', async () => {
    const { call, service, host } = setup()
    await call('downloads', { type: 'clear' })
    await call('downloads', { type: 'openFolder' })
    expect(service.clear).toHaveBeenCalled()
    expect(host.openFolder).toHaveBeenCalled()
  })

  it('lets only the Settings page choose or reset the folder, and read it', async () => {
    const { call, host } = setup()
    expect(await call('downloads', { type: 'chooseFolder' })).toBeUndefined()
    expect(await call('downloads', { type: 'resetFolder' })).toBeUndefined()
    expect(await call('downloads', { type: 'folder' })).toBeUndefined()
    expect(host.chooseFolder).not.toHaveBeenCalled()
    expect(await call('settings', { type: 'folder' })).toEqual({ folder: '/dl', custom: true })
    expect(await call('settings', { type: 'chooseFolder' })).toEqual({ ok: true })
    expect(await call('settings', { type: 'resetFolder' })).toEqual({ ok: true })
    expect(host.resetFolder).toHaveBeenCalled()
  })

  it('does not let the Settings page act on a download', async () => {
    const { call, service } = setup()
    expect(await call('settings', { type: 'remove', id: 'a' })).toBeUndefined()
    expect(await call('settings', { type: 'list' })).toBeUndefined()
    expect(service.remove).not.toHaveBeenCalled()
  })
})
