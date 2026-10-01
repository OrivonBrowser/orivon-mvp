import { describe, expect, it } from 'vitest'
import type { Article } from '../../../../main/reader/reader-blocks.js'
import type { OrivonInternal } from '../../shared/bridge.js'
import { ReaderState } from '../state.js'

const ARTICLE: Article = { title: 'T', byline: '', site: '', url: 'https://example.com/a', lang: 'en', words: 3, blocks: [{ t: 'p', c: ['x'] }] }

function make (reply: (command: { type: string, key?: string, value?: string }) => unknown) {
  const requests: unknown[] = []
  const bridge = {
    page: 'reader',
    platform: 'linux',
    request: async (_domain: string, command: unknown) => { requests.push(command); return await Promise.resolve(reply(command as { type: string })) },
    onEvent: () => () => {}
  } as unknown as OrivonInternal
  const state = new ReaderState(bridge)
  const changes: string[] = []
  state.onChange((what) => { changes.push(what) })
  return { state, requests, changes }
}

describe('ReaderState', () => {
  it('loads the article, its pictures and the preferences', async () => {
    const { state, changes } = make(() => ({ article: ARTICLE, token: 3, images: { 2: 'data:image/png;base64,AAAA' }, prefs: { font: 'serif', size: '20', width: 'wide', theme: 'sepia' } }))
    await state.load()
    expect(state.status).toBe('ready')
    expect(state.article).toEqual(ARTICLE)
    expect(state.images.get(2)).toBe('data:image/png;base64,AAAA')
    expect(state.prefs).toEqual({ font: 'serif', size: '20', width: 'wide', theme: 'sepia' })
    expect(changes).toEqual(['all'])
  })

  it('is empty without an article and in error when main cannot answer', async () => {
    const empty = make(() => ({ article: null, prefs: {} }))
    await empty.state.load()
    expect(empty.state.status).toBe('empty')
    const broken = make(() => { throw new Error('no') })
    await broken.state.load()
    expect(broken.state.status).toBe('error')
    const silent = make(() => undefined)
    await silent.state.load()
    expect(silent.state.status).toBe('error')
  })

  it('keeps its place when the same article arrives again', async () => {
    const { state, changes } = make(() => ({ article: ARTICLE, token: 1, prefs: {} }))
    await state.load()
    await state.load()
    expect(changes).toEqual(['all', 'image'])
  })

  it('takes a picture only for the article it shows', async () => {
    const { state, changes } = make(() => ({ article: ARTICLE, token: 7, prefs: {} }))
    await state.load()
    state.handle('reader.image', { token: 6, at: 1, src: 'data:image/png;base64,AAAA' })
    expect(state.images.size).toBe(0)
    state.handle('reader.image', { token: 7, at: 1, src: 'data:image/png;base64,AAAA' })
    expect(state.images.get(1)).toBe('data:image/png;base64,AAAA')
    expect(changes).toEqual(['all', 'image'])
  })

  it('follows a changed reading setting, and ignores a key that is not one', () => {
    const { state } = make(() => undefined)
    state.handle('reader.settings', { key: 'reader.theme', value: 'dark' })
    expect(state.prefs.theme).toBe('dark')
    state.handle('reader.settings', { key: 'reader.nonsense', value: 'x' })
    state.handle('reader.settings', { key: 'search.engine', value: 'x' })
    expect(Object.keys(state.prefs).sort()).toEqual(['font', 'size', 'theme', 'width'])
  })

  it('applies a preference at once, tells main, and puts the old value back when main refuses', async () => {
    const accepted = make((command) => command.type === 'pref' ? { ok: true } : undefined)
    await accepted.state.setPref('theme', 'dark')
    expect(accepted.state.prefs.theme).toBe('dark')
    expect(accepted.requests).toContainEqual({ type: 'pref', key: 'reader.theme', value: 'dark' })
    const refused = make(() => ({ ok: false }))
    await refused.state.setPref('theme', 'dark')
    expect(refused.state.prefs.theme).toBe('auto')
  })

  it('sends only an index to open a link', () => {
    const { state, requests } = make(() => undefined)
    state.openLink(3)
    state.back()
    state.print()
    expect(requests).toEqual([{ type: 'open', index: 3 }, { type: 'back' }, { type: 'print' }])
  })
})
