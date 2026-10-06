import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import { appDataRoot, originHash } from '../../../broker/grants/origin-hash.js'
import { LocalFileApps, installLocalFileApps } from '../local-file-apps.js'
import { deleteLocalFileData } from '../delete-local-file-data.js'

const KEY = 'file:///home/u/notes/app.html'
const OTHER = 'file:///home/u/notes/other.html'

let userData: string

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'orivon-delete-local-'))
  const apps = new LocalFileApps(join(userData, 'local-file-apps.json'))
  apps.add(KEY)
  apps.add(OTHER)
  installLocalFileApps(apps)
})
afterEach(async () => { installLocalFileApps(undefined); await rm(userData, { recursive: true, force: true }) })

function brokerWith (): Broker {
  return {
    revokePersisted: vi.fn(async () => true), revokeUserSelectedPath: vi.fn(async () => true), clearDeclinedConsent: vi.fn(async () => {}),
    app: { persistedAppsSync: () => [{ origin: KEY, appName: 'N', grants: { fs: {} }, pickedPaths: {} }] }
  } as unknown as Broker
}

describe('deleteLocalFileData', () => {
  it('revokes the grants, clears the file\'s own session, removes its folder and its record, and leaves other files alone', async () => {
    const broker = brokerWith()
    await mkdir(appDataRoot(userData, KEY), { recursive: true })
    await writeFile(join(appDataRoot(userData, KEY), 'f.txt'), 'x')
    await mkdir(appDataRoot(userData, OTHER), { recursive: true })
    const clearPartition = vi.fn(async () => {})

    expect(await deleteLocalFileData({ broker, userDataPath: userData, clearPartition }, KEY)).toBe(true)

    expect(broker.revokePersisted).toHaveBeenCalledWith(KEY, 'fs')
    expect(clearPartition).toHaveBeenCalledExactlyOnceWith(`persist:local-${originHash(KEY)}`)
    expect(await readdir(join(userData, 'app-data'))).toEqual([originHash(OTHER)])
    const record = new LocalFileApps(join(userData, 'local-file-apps.json'))
    expect(record.list()).toEqual([OTHER])
  })

  it('goes on to the record when a folder or a session cannot be cleared, and says so', async () => {
    const broker = brokerWith()
    const clearPartition = vi.fn(async () => { throw new Error('session gone') })
    expect(await deleteLocalFileData({ broker, userDataPath: userData, clearPartition }, KEY)).toBe(false)
    expect(new LocalFileApps(join(userData, 'local-file-apps.json')).list()).toEqual([OTHER])
  })

  it('refuses a key that is not a local file, and changes nothing', async () => {
    const broker = brokerWith()
    const clearPartition = vi.fn(async () => {})
    expect(await deleteLocalFileData({ broker, userDataPath: userData, clearPartition }, 'https://example.com')).toBe(false)
    expect(clearPartition).not.toHaveBeenCalled()
    expect(broker.revokePersisted).not.toHaveBeenCalled()
  })

  it('works with no broker published, which has nothing to revoke', async () => {
    const clearPartition = vi.fn(async () => {})
    expect(await deleteLocalFileData({ broker: undefined, userDataPath: userData, clearPartition }, KEY)).toBe(true)
  })
})
