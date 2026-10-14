import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { StartInfo } from '../../downloads/download-service.js'
import { createAutoDownloads } from '../auto-downloads.js'
import { PageAccess } from '../page-access.js'
import type { SiteAnswer } from '../site-asks-engine.js'
import { SiteSettingsStore } from '../site-settings-store.js'

const SITE = 'https://files.example'

class FakeTab extends EventEmitter {
  destroyed = false
  url = `${SITE}/page`
  opener: { url: string } | null = null
  getURL (): string { return this.url }
  isDestroyed (): boolean { return this.destroyed }
}

function item () {
  return { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() }
}

function rig (options: { defaultFor?: 'ask' | 'block', apps?: string[], isTab?: boolean } = {}) {
  const tab = new FakeTab()
  const store = new SiteSettingsStore(null)
  const access = new PageAccess<WebContents>()
  let answer: (value: SiteAnswer) => void = () => {}
  const ask = vi.fn(() => new Promise<SiteAnswer>((resolve) => { answer = resolve }))
  const onStart = createAutoDownloads({
    store,
    defaultFor: () => options.defaultFor ?? 'ask',
    isApp: (origin) => options.apps?.includes(origin) === true,
    isTab: () => options.isTab !== false,
    ask,
    access
  })
  const start = (userGesture: boolean, contents: unknown = tab): ReturnType<typeof item> => {
    const downloaded = item()
    onStart({ id: 'd', item: downloaded, contents: contents ?? undefined, userGesture } as unknown as StartInfo)
    return downloaded
  }
  const settle = async (): Promise<void> => { await new Promise((resolve) => { setImmediate(resolve) }) }
  return { tab, store, access, ask, start, answer: (value: SiteAnswer) => { answer(value) }, settle }
}

describe('automatic downloads', () => {
  it('lets the first download of a page through, whatever started it', () => {
    const r = rig()
    const first = r.start(false)
    expect(first.pause).not.toHaveBeenCalled()
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('never holds a download the person clicked for', () => {
    const r = rig()
    r.start(true)
    const second = r.start(true)
    expect(second.pause).not.toHaveBeenCalled()
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('holds a second download with no click and asks, naming the kind and the tab', () => {
    const r = rig()
    r.start(false)
    const second = r.start(false)
    expect(second.pause).toHaveBeenCalled()
    expect(r.ask).toHaveBeenCalledWith(['autoDownloads'], r.tab)
  })

  it('counts a download the person clicked for as an earlier one', () => {
    const r = rig()
    r.start(true)
    r.start(false)
    expect(r.ask).toHaveBeenCalledTimes(1)
  })

  it('resumes the held download on Allow, remembers it for the site and notes it on the page', async () => {
    const r = rig()
    r.start(false)
    const second = r.start(false)
    r.answer('allow')
    await r.settle()
    expect(second.resume).toHaveBeenCalled()
    expect(second.cancel).not.toHaveBeenCalled()
    expect(r.store.get(SITE, 'autoDownloads')).toBe('allow')
    expect(r.access.entries(r.tab as unknown as WebContents)).toEqual([{ kind: 'autoDownloads', state: 'allowed' }])
  })

  it('cancels it on Block and remembers that', async () => {
    const r = rig()
    r.start(false)
    const second = r.start(false)
    r.answer('block')
    await r.settle()
    expect(second.cancel).toHaveBeenCalled()
    expect(r.store.get(SITE, 'autoDownloads')).toBe('block')
  })

  it('cancels it when the question is closed without an answer, and stores nothing', async () => {
    const r = rig()
    r.start(false)
    const second = r.start(false)
    r.answer('dismiss')
    await r.settle()
    expect(second.cancel).toHaveBeenCalled()
    expect(r.store.get(SITE, 'autoDownloads')).toBeUndefined()
  })

  it('shares one question between downloads that wait together', async () => {
    const r = rig()
    r.start(false)
    const a = r.start(false)
    const b = r.start(false)
    expect(r.ask).toHaveBeenCalledTimes(1)
    r.answer('allow')
    await r.settle()
    expect(a.resume).toHaveBeenCalled()
    expect(b.resume).toHaveBeenCalled()
  })

  it('does not ask for a site already allowed, and refuses without asking for one already blocked', () => {
    const r = rig()
    r.store.set(SITE, 'autoDownloads', 'allow')
    r.start(false)
    expect(r.start(false).cancel).not.toHaveBeenCalled()
    r.store.set(SITE, 'autoDownloads', 'block')
    expect(r.start(false).cancel).toHaveBeenCalled()
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('refuses without asking when the default is to block', () => {
    const r = rig({ defaultFor: 'block' })
    r.start(false)
    const second = r.start(false)
    expect(second.cancel).toHaveBeenCalled()
    expect(r.ask).not.toHaveBeenCalled()
    expect(r.access.entries(r.tab as unknown as WebContents)).toEqual([{ kind: 'autoDownloads', state: 'blocked' }])
  })

  it('starts counting again on a new page load', () => {
    const r = rig()
    r.start(false)
    r.tab.emit('did-navigate')
    r.start(false)
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('leaves a registered app, a download with no tab and one from a page that is not a tab alone', () => {
    const app = rig({ apps: [SITE] })
    app.start(false)
    expect(app.start(false).pause).not.toHaveBeenCalled()
    const noTab = rig()
    noTab.start(false, null)
    expect(noTab.start(false, null).pause).not.toHaveBeenCalled()
    const notATab = rig({ isTab: false })
    notATab.start(false)
    expect(notATab.start(false).pause).not.toHaveBeenCalled()
  })

  it('cancels a held download when its tab went away during the question', async () => {
    const r = rig()
    r.start(false)
    const second = r.start(false)
    r.tab.destroyed = true
    r.answer('allow')
    await r.settle()
    expect(second.cancel).toHaveBeenCalled()
    expect(r.store.get(SITE, 'autoDownloads')).toBeUndefined()
  })
})

describe('automatic downloads from a blank or blob: page', () => {
  function blank (url: string, opener: string | null) {
    const r = rig({ defaultFor: 'block' })
    const tab = new FakeTab()
    tab.url = url
    tab.opener = opener === null ? null : { url: opener }
    r.start(false, tab)
    return { r, tab }
  }

  it('refuses the second unclicked one of a site told to block, unasked', () => {
    for (const url of ['about:blank', '', `blob:${SITE}/uuid`]) {
      const r = rig()
      r.store.set(SITE, 'autoDownloads', 'block')
      const tab = new FakeTab()
      tab.url = url
      tab.opener = { url: `${SITE}/page` }
      expect(r.start(false, tab).cancel).not.toHaveBeenCalled()
      const second = r.start(false, tab)
      expect(second.cancel, url).toHaveBeenCalled()
      expect(r.ask).not.toHaveBeenCalled()
    }
  })

  it('lets it through when the site that made the page allowed automatic downloads', () => {
    const r = rig()
    r.store.set(SITE, 'autoDownloads', 'allow')
    const tab = new FakeTab()
    tab.url = 'about:blank'
    tab.opener = { url: `${SITE}/page` }
    r.start(false, tab)
    const second = r.start(false, tab)
    expect(second.cancel).not.toHaveBeenCalled()
    expect(second.pause).not.toHaveBeenCalled()
  })

  it('refuses without asking when the site has no answer, since there is no page to ask about', () => {
    const r = rig()
    const tab = new FakeTab()
    tab.url = 'about:blank'
    tab.opener = { url: `${SITE}/page` }
    r.start(false, tab)
    const second = r.start(false, tab)
    expect(second.cancel).toHaveBeenCalled()
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('refuses when the opener cannot be told', () => {
    const { tab, r } = blank('about:blank', null)
    expect(r.start(false, tab).cancel).toHaveBeenCalled()
  })

  it('leaves an app\'s blank popup alone', () => {
    const r = rig({ apps: [SITE] })
    const tab = new FakeTab()
    tab.url = 'about:blank'
    tab.opener = { url: `${SITE}/page` }
    r.start(false, tab)
    expect(r.start(false, tab).cancel).not.toHaveBeenCalled()
  })
})
