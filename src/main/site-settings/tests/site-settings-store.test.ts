import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SITE_ORIGINS, SiteSettingsStore } from '../site-settings-store.js'

const dirs: string[] = []
function tempFile (contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-site-settings-'))
  dirs.push(dir)
  const file = join(dir, 'site-settings.json')
  if (contents !== undefined) writeFileSync(file, contents)
  return file
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const SITE = 'https://chat.example'

describe('SiteSettingsStore', () => {
  it('says whether any site is blocked for a kind', () => {
    const store = new SiteSettingsStore(null)
    expect(store.hasBlock('images')).toBe(false)
    store.set(SITE, 'images', 'allow')
    store.set(SITE, 'javascript', 'block')
    expect(store.hasBlock('images')).toBe(false)
    expect(store.hasBlock('javascript')).toBe(true)
    store.forget(SITE, 'javascript')
    expect(store.hasBlock('javascript')).toBe(false)
  })

  it('remembers an answer per site and kind, and forgets one on request', () => {
    const store = new SiteSettingsStore(null)
    store.set(SITE, 'camera', 'allow')
    store.set(SITE, 'microphone', 'block')
    expect(store.get(SITE, 'camera')).toBe('allow')
    expect(store.get(SITE, 'microphone')).toBe('block')
    expect(store.get(SITE, 'location')).toBeUndefined()
    expect(store.get('https://other.example', 'camera')).toBeUndefined()
    store.forget(SITE, 'camera')
    expect(store.get(SITE, 'camera')).toBeUndefined()
    expect(store.get(SITE, 'microphone')).toBe('block')
    expect(store.entries()).toEqual([{ origin: SITE, kind: 'microphone', value: 'block' }])
  })

  it('refuses what is not an origin, a kind or an answer', () => {
    const store = new SiteSettingsStore(null)
    store.set('https://chat.example/path', 'camera', 'allow')
    store.set('file:///etc/passwd', 'camera', 'allow')
    store.set(SITE, 'nonsense' as never, 'allow')
    store.set(SITE, 'camera', 'ask' as never)
    expect(store.entries()).toEqual([])
  })

  it('tells its listeners which site changed, and nothing for a change that changes nothing', () => {
    const store = new SiteSettingsStore(null)
    const listener = vi.fn()
    const stop = store.onChange(listener)
    store.set(SITE, 'camera', 'allow')
    store.set(SITE, 'camera', 'allow')
    store.forget(SITE, 'microphone')
    expect(listener.mock.calls).toEqual([[SITE]])
    store.clear()
    expect(listener).toHaveBeenLastCalledWith(null)
    stop()
    store.set(SITE, 'camera', 'block')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('writes the file, and a new store reads it back', async () => {
    const file = tempFile()
    const store = new SiteSettingsStore(file)
    store.set(SITE, 'camera', 'allow')
    store.set('https://maps.example', 'location', 'block')
    await store.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, sites: { [SITE]: { camera: 'allow' }, 'https://maps.example': { location: 'block' } } })
    const again = new SiteSettingsStore(file)
    expect(again.get(SITE, 'camera')).toBe('allow')
    expect(again.get('https://maps.example', 'location')).toBe('block')
  })

  it('drops an entry it would not have written itself, and keeps the rest', () => {
    const file = tempFile(JSON.stringify({
      version: 1,
      sites: {
        [SITE]: { camera: 'allow', microphone: 'maybe', bogus: 'allow', location: 'block' },
        'https://chat.example/with/path': { camera: 'allow' },
        'not a url': { camera: 'allow' },
        'https://empty.example': {},
        'https://arr.example': ['camera']
      }
    }))
    const store = new SiteSettingsStore(file)
    expect(store.entries()).toEqual([
      { origin: SITE, kind: 'camera', value: 'allow' },
      { origin: SITE, kind: 'location', value: 'block' }
    ])
  })

  it.each([
    ['corrupt', '{not json'],
    ['another version', JSON.stringify({ version: 2, sites: { [SITE]: { camera: 'allow' } } })],
    ['not an object', '[]'],
    ['no sites', JSON.stringify({ version: 1 })]
  ])('starts empty from a %s file', (_name, contents) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(new SiteSettingsStore(tempFile(contents)).entries()).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('starts empty when there is no file, and says nothing about it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(new SiteSettingsStore(join(tmpdir(), 'orivon-no-such-dir', 'site-settings.json')).entries()).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('forgets the site written longest ago once it holds too many', () => {
    const store = new SiteSettingsStore(null)
    for (let index = 0; index <= MAX_SITE_ORIGINS; index++) store.set(`https://site${String(index)}.example`, 'camera', 'allow')
    expect(store.size).toBe(MAX_SITE_ORIGINS)
    expect(store.get('https://site0.example', 'camera')).toBeUndefined()
    expect(store.get('https://site1.example', 'camera')).toBe('allow')
    // A site written again counts as recent.
    store.set('https://site1.example', 'microphone', 'allow')
    store.set('https://another.example', 'camera', 'allow')
    expect(store.get('https://site1.example', 'camera')).toBe('allow')
    expect(store.get('https://site2.example', 'camera')).toBeUndefined()
  })

  it('keeps everything in memory and writes no file when it has no path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-site-settings-'))
    dirs.push(dir)
    const store = new SiteSettingsStore(null)
    store.set(SITE, 'camera', 'allow')
    await store.flush()
    expect(store.persistent).toBe(false)
    expect(store.get(SITE, 'camera')).toBe('allow')
    expect(existsSync(join(dir, 'site-settings.json'))).toBe(false)
  })

  it('forgets a whole site', () => {
    const store = new SiteSettingsStore(null)
    store.set(SITE, 'camera', 'allow')
    store.set(SITE, 'location', 'block')
    store.forgetOrigin(SITE)
    expect(store.forOrigin(SITE).size).toBe(0)
  })

  it('keeps a block for a kind that remembers only a block, and refuses an allow', () => {
    const store = new SiteSettingsStore(null)
    store.set(SITE, 'screenShare', 'allow')
    expect(store.get(SITE, 'screenShare')).toBeUndefined()
    store.set(SITE, 'screenShare', 'block')
    expect(store.get(SITE, 'screenShare')).toBe('block')
  })

  it('drops a stored allow for a kind that remembers only a block, on read', () => {
    const file = tempFile(JSON.stringify({ version: 1, sites: { [SITE]: { screenShare: 'allow', camera: 'allow' }, 'https://b.example': { screenShare: 'block' } } }))
    const store = new SiteSettingsStore(file)
    expect(store.entries()).toEqual([
      { origin: SITE, kind: 'camera', value: 'allow' },
      { origin: 'https://b.example', kind: 'screenShare', value: 'block' }
    ])
  })
})
