import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeLoaderStorage } from '../node-storage.js'
import { appRootDirectoryName } from '../storage.js'
import { manifestJson } from '../../tests/test-helpers.js'

// The record of an app the person allowed and whose pin has not landed: written beside the pin's own file,
// listed at startup by what each record itself claims, and read back as untrusted input.

const APP = 'https://app.example'
const record = (origin: string): object => ({ schema: 1, origin, manifestBytes: Buffer.from(manifestJson()).toString('base64'), consentedAt: 1 })

describe('nodeLoaderStorage, pending consents', () => {
  it('writes, reads, lists and deletes a record', async () => {
    const storage = nodeLoaderStorage(await mkdtemp(join(tmpdir(), 'orivon-loader-pending-')))
    expect(await storage.readPending(APP)).toBeUndefined()
    expect(await storage.listPendingOrigins()).toEqual([])
    await storage.writePending(APP, record(APP))
    await storage.writePending('https://other.example', record('https://other.example'))
    expect(await storage.readPending(APP)).toMatchObject({ origin: APP })
    expect([...await storage.listPendingOrigins()].sort()).toEqual([APP, 'https://other.example'])
    await storage.writePending(APP, undefined)
    expect(await storage.readPending(APP)).toBeUndefined()
    expect(await storage.listPendingOrigins()).toEqual(['https://other.example'])
  })

  it('does not list a record that is no record, or that sits in another app\'s directory', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-pending-'))
    const wrong = join(userData, 'apps', appRootDirectoryName('https://elsewhere.example'))
    await mkdir(wrong, { recursive: true })
    await writeFile(join(wrong, 'pending.json'), JSON.stringify(record(APP)))
    const garbage = join(userData, 'apps', appRootDirectoryName('https://garbage.example'))
    await mkdir(garbage, { recursive: true })
    await writeFile(join(garbage, 'pending.json'), '{ not json')
    expect(await nodeLoaderStorage(userData).listPendingOrigins()).toEqual([])
  })

  it('leaves the pin enumeration to pins', async () => {
    const storage = nodeLoaderStorage(await mkdtemp(join(tmpdir(), 'orivon-loader-pending-')))
    await storage.writePending(APP, record(APP))
    expect(await storage.listPinnedOrigins()).toEqual([])
  })
})
