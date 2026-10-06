import { afterEach, describe, expect, it, vi } from 'vitest'
import { originHash } from '../../../broker/grants/origin-hash.js'
import { LocalFileApps, installLocalFileApps } from '../local-file-apps.js'
import { fenceAllows, installLocalFileFence } from '../local-file-fence.js'
import { LOCAL_FILES_PARTITION } from '../partition.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GRANTED = 'file:///home/u/notes/app.html'
const GRANTED_PARTITION = `persist:local-${originHash(GRANTED)}`
const PLAIN = 'file:///home/u/notes/plain.html'

let dir: string | undefined
afterEach(() => {
  installLocalFileApps(undefined)
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function withRecorded (...keys: string[]): void {
  dir = mkdtempSync(join(tmpdir(), 'orivon-fence-'))
  const apps = new LocalFileApps(join(dir, 'a.json'))
  for (const key of keys) apps.add(key)
  installLocalFileApps(apps)
}

describe('fenceAllows -- a local session loads only the files that belong to it', () => {
  it('lets the shared session load an unrecorded file, and its query and fragment', () => {
    expect(fenceAllows(PLAIN, LOCAL_FILES_PARTITION)).toBe(true)
    expect(fenceAllows(`${PLAIN}?q=1#top`, LOCAL_FILES_PARTITION)).toBe(true)
  })

  it('lets a recorded file\'s own session load that file and nothing else', () => {
    withRecorded(GRANTED)

    expect(fenceAllows(GRANTED, GRANTED_PARTITION)).toBe(true)
    expect(fenceAllows(`${GRANTED}?x=1`, GRANTED_PARTITION)).toBe(true)
    expect(fenceAllows(PLAIN, GRANTED_PARTITION)).toBe(false)
    expect(fenceAllows('file:///home/u/notes/app.html.bak', GRANTED_PARTITION)).toBe(false)
  })

  it('refuses the shared session a file that has since been recorded', () => {
    withRecorded(GRANTED)

    expect(fenceAllows(GRANTED, LOCAL_FILES_PARTITION)).toBe(false)
  })

  it('refuses a file a recorded session holds no more, so a removed record moves the tab back', () => {
    withRecorded(GRANTED)
    const apps = new LocalFileApps(join(dir as string, 'a.json'))
    apps.remove(GRANTED)
    installLocalFileApps(apps)

    expect(fenceAllows(GRANTED, GRANTED_PARTITION)).toBe(false)
    expect(fenceAllows(GRANTED, LOCAL_FILES_PARTITION)).toBe(true)
  })

  it('refuses a file URL that is not a local file at all: a host, a share', () => {
    expect(fenceAllows('file://server/share/a.html', LOCAL_FILES_PARTITION)).toBe(false)
    expect(fenceAllows('file:////server/share/a.html', LOCAL_FILES_PARTITION)).toBe(false)
  })
})

describe('installLocalFileFence', () => {
  it('registers on file: documents only (main frame, frames and objects), not on a subresource', () => {
    const onBeforeRequest = vi.fn()
    installLocalFileFence({ onBeforeRequest }, LOCAL_FILES_PARTITION)

    const [order, filter, matches] = onBeforeRequest.mock.calls[0] as [number, { urls: string[], types: string[] }, (url: string) => boolean]
    expect(order).toBe(0)
    expect(filter.urls).toEqual(['file:///*'])
    expect([...filter.types].sort()).toEqual(['mainFrame', 'object', 'subFrame'])
    expect(matches(PLAIN)).toBe(true)
    expect(matches('https://x.example/')).toBe(false)
  })

  it('cancels a load that belongs to another session and passes the rest through unchanged', () => {
    withRecorded(GRANTED)
    const onBeforeRequest = vi.fn()
    installLocalFileFence({ onBeforeRequest }, LOCAL_FILES_PARTITION)
    const run = onBeforeRequest.mock.calls[0]?.[3] as (details: { url: string }, current: unknown) => unknown
    const current = { redirectURL: undefined }

    expect(run({ url: GRANTED }, current)).toEqual({ cancel: true })
    expect(run({ url: PLAIN }, current)).toBe(current)
  })
})
