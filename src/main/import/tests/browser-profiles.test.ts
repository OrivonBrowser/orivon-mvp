import { describe, expect, it } from 'vitest'
import { detectSources } from '../browser-profiles.js'
import type { BrowserRoot } from '../import-types.js'
import { fakeFs } from './fake-fs.js'

const chrome: BrowserRoot = { browser: 'chrome', family: 'chromium', root: '/h/.config/google-chrome' }
const firefox: BrowserRoot = { browser: 'firefox', family: 'firefox', root: '/h/.mozilla/firefox' }

describe('detectSources, Chromium family', () => {
  it('names the profiles from Local State and keeps the ones with bookmarks or history', async () => {
    const fs = fakeFs({
      '/h/.config/google-chrome/Local State': JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' }, 'Profile 2': { name: 'Empty' } } } }),
      '/h/.config/google-chrome/Default/Bookmarks': '{}',
      '/h/.config/google-chrome/Profile 1/History': '',
      '/h/.config/google-chrome/Profile 2/Cookies': ''
    })
    expect(await detectSources(fs, [chrome])).toEqual([
      { browser: 'chrome', family: 'chromium', profile: 'Person 1', dir: '/h/.config/google-chrome/Default' },
      { browser: 'chrome', family: 'chromium', profile: 'Work', dir: '/h/.config/google-chrome/Profile 1' }
    ])
  })

  it('scans for Default and Profile N directories without Local State', async () => {
    const fs = fakeFs({
      '/h/.config/google-chrome/Default/History': '',
      '/h/.config/google-chrome/Profile 3/Bookmarks': '{}',
      '/h/.config/google-chrome/Crashpad/History': '',
      '/h/.config/google-chrome/ShaderCache/x': ''
    })
    expect((await detectSources(fs, [chrome])).map((source) => source.profile)).toEqual(['Default', 'Profile 3'])
  })

  it('scans when Local State is not JSON', async () => {
    const fs = fakeFs({ '/h/.config/google-chrome/Local State': 'nope', '/h/.config/google-chrome/Default/History': '' })
    expect((await detectSources(fs, [chrome])).map((source) => source.profile)).toEqual(['Default'])
  })

  it('finds nothing where the browser is not installed', async () => {
    expect(await detectSources(fakeFs({}), [chrome, firefox])).toEqual([])
  })

  it('refuses a profile name that is a path, and one that links out of the root', async () => {
    const fs = fakeFs({
      '/h/.config/google-chrome/Local State': JSON.stringify({ profile: { info_cache: { '../../secret': { name: 'Bad' }, 'a/b': { name: 'Worse' }, Default: { name: 'Linked' } } } }),
      '/secret/Bookmarks': '{}',
      '/h/.config/google-chrome/x': ''
    }, { '/h/.config/google-chrome/Default': '/secret' })
    expect(await detectSources(fs, [chrome])).toEqual([])
  })

  it('does not list one directory twice when two roots reach it', async () => {
    const fs = fakeFs({ '/h/.config/google-chrome/Default/History': '' })
    expect(await detectSources(fs, [chrome, { ...chrome, browser: 'chromium' }])).toHaveLength(1)
  })
})

describe('detectSources, Firefox', () => {
  const ini = '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\n\n[Profile1]\nName=old\nIsRelative=1\nPath=def.old\n\n[Install4F96D1932A9F858E]\nDefault=abc.default-release\n'

  it('reads profiles.ini and keeps the profiles that have places.sqlite', async () => {
    const fs = fakeFs({ '/h/.mozilla/firefox/profiles.ini': ini, '/h/.mozilla/firefox/abc.default-release/places.sqlite': '', '/h/.mozilla/firefox/def.old/prefs.js': '' })
    expect(await detectSources(fs, [firefox])).toEqual([{ browser: 'firefox', family: 'firefox', profile: 'default-release', dir: '/h/.mozilla/firefox/abc.default-release' }])
  })

  it('refuses an absolute path outside the root and a relative path that climbs out', async () => {
    const fs = fakeFs({
      '/h/.mozilla/firefox/profiles.ini': '[Profile0]\nName=a\nIsRelative=0\nPath=/etc\n[Profile1]\nName=b\nIsRelative=1\nPath=../../other\n',
      '/etc/places.sqlite': '',
      '/h/other/places.sqlite': '',
      '/h/.mozilla/firefox/x': ''
    })
    expect(await detectSources(fs, [firefox])).toEqual([])
  })

  it('refuses a profile directory that is a link to elsewhere', async () => {
    const fs = fakeFs({ '/h/.mozilla/firefox/profiles.ini': '[Profile0]\nName=a\nIsRelative=1\nPath=p\n', '/elsewhere/places.sqlite': '' }, { '/h/.mozilla/firefox/p': '/elsewhere' })
    expect(await detectSources(fs, [firefox])).toEqual([])
  })
})
