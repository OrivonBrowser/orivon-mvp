import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import type { LoadRefusal } from '../../route/load-refusals.js'
import type { SlotAsk } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { REFUSAL_WORDS, refusalSentence } from '../../route/name-relay/relay-failures.js'
import type { RefusalWord } from '../../route/name-relay/relay-failures.js'
import { nameRelayStatus, setNameRelayStatusSource } from '../../route/name-relay/relay-status.js'
import { loadErrorOverlay } from '../load-error-overlay.js'
import { isErrorName, loadErrorText } from '../load-error-text.js'
import { forgetLoadErrors, watchLoadErrors } from '../load-error-watch.js'

describe('what the load-error sheet says', () => {
  it('names the usual failures in words, and has a sentence for any other code', () => {
    expect(loadErrorText(-105)).toEqual({ title: 'This site can\'t be reached', body: 'No server answers to this name. Check the address for a typing mistake.' })
    expect(loadErrorText(-102).body).toBe('The server refused the connection.')
    expect(loadErrorText(-106).title).toBe('You are offline')
    expect(loadErrorText(-20).title).toBe('This page was blocked')
    for (const code of [-111, -130]) expect(loadErrorText(code).body, String(code)).toContain('The tunnel did not carry this page, and nothing was sent outside it.')
    expect(loadErrorText(-999)).toEqual({ title: 'This page couldn\'t be loaded', body: 'Something went wrong while loading it. Trying again may help.' })
  })

  it('says an onion address opens only through a Tor tunnel, and where to set one up, for a load cancelled for being one', () => {
    const text = loadErrorText(-20, 'onion')
    expect(text.title).toBe('This site can\'t be reached')
    expect(text.body).toContain('onion address')
    expect(text.body).toContain('Tor')
    expect(text.body).toContain('Settings, then Tunnels')
    expect(text.body).not.toMatch(/extension|content filter/)
    expect(loadErrorText(-20)).toEqual({ title: 'This page was blocked', body: 'An extension or a content filter stopped this page from loading.' })
  })

  it('says the system proxy would see a name the verifier serves, and when it opens, for a load cancelled for that', () => {
    const text = loadErrorText(-20, 'would-see')
    expect(text.title).toBe('This name was not opened')
    expect(text.body).toBe('Your system proxy would see this name, so Orivon did not open it. Names like this open when your system has no proxy, when the proxy\'s exceptions list names like *.eth, or with a tunnel turned on.')
    expect(text.body).not.toMatch(/extension|content filter|onion/)
  })

  it('says it could not tell, apart from saying the proxy would see the name, and where the exceptions go', () => {
    const text = loadErrorText(-20, 'unsure')
    expect(text.title).toBe('This name was not opened')
    expect(text.body).toContain('could not tell whether your system proxy would see this name')
    expect(text.body).toContain('Trying again may help.')
    expect(text.body).toContain('exceptions list names like *.eth')
    expect(text.body).not.toContain('Your system proxy would see this name')
  })

  it('says a name over plain http opens only over a secure connection, whatever the proxy is', () => {
    const text = loadErrorText(-20, 'plain')
    expect(text.title).toBe('This name opens only over https')
    expect(text.body).toBe('A name like this opens only over a secure connection, so Orivon did not open it over plain http.')
  })

  it('says why the name relay did not carry a connection, in the words for that refusal with the provider named, in place of the tunnel\'s', () => {
    for (const word of REFUSAL_WORDS) {
      const text = loadErrorText(-111, undefined, { word, provider: 'Cloudflare' })
      expect(text, word).toEqual({ title: 'This site can\'t be reached', body: refusalSentence(word, 'Cloudflare') })
      expect(text.body, word).not.toContain('tunnel did not carry')
    }
    expect(loadErrorText(-111, undefined, { word: 'not-found', provider: 'Quad9' }).body).toContain('Look up site addresses in Orivon')
    expect(loadErrorText(-111, undefined, { word: 'no-answer', provider: 'Quad9' }).body).toContain('Quad9')
  })

  it('shows an error name only when it is one of Chromium\'s', () => {
    for (const name of ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_HTTP2_PROTOCOL_ERROR']) expect(isErrorName(name), name).toBe(true)
    for (const name of ['', 'err_x', 'ERR_', 'ERR_<b>', 'Send money ERR_X', 42, undefined, `ERR_${'A'.repeat(61)}`]) expect(isErrorName(name), String(name)).toBe(false)
  })
})

describe('the load-error watcher', () => {
  const WINDOW = { tabs: { partitionOf: (id: string) => id === 't1' ? 'persist:orivon-local-files' : undefined } } as unknown as ShellWindow

  function setup (claimed = false, movesTab: (partition: string | undefined, url: string, code: number) => boolean = () => false): { contents: EventEmitter & { getURL: () => string, id: number }, asks: SlotAsk[], cancel: ReturnType<typeof vi.fn>, deps: Parameters<typeof watchLoadErrors>[1], shown: { url: string } } {
    const shown = { url: '' }
    const contents = Object.assign(new EventEmitter(), { getURL: () => shown.url, id: 7 })
    const asks: SlotAsk[] = []
    const cancel = vi.fn()
    return {
      contents, asks, cancel, shown,
      deps: {
        findTab: (candidate) => candidate === (contents as unknown as WebContents) ? { window: WINDOW, tabId: 't1' } : null,
        ask: (ask) => { asks.push(ask); return { cancel } },
        claimed: () => claimed,
        movesTab
      }
    }
  }
  const fail = (s: ReturnType<typeof setup>, code: number, url: string, main = true, name = 'ERR_NAME_NOT_RESOLVED'): void => {
    s.shown.url = url
    s.contents.emit('did-fail-load', {}, code, name, url, main)
  }

  it('asks for the sheet over the tab when its page fails to load', () => {
    const s = setup()
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    fail(s, -105, 'http://unresolvable.invalid/')
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toMatchObject({ window: WINDOW, tabId: 't1', slot: 'center', overlay: 'load-error', payload: { code: -105, name: 'ERR_NAME_NOT_RESOLVED' } })
  })

  it('stays out for a frame, a cancelled load, a certificate failure, a failure another sheet explains, and a failure that left the earlier page showing', () => {
    const s = setup()
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    fail(s, -105, 'http://a.invalid/', false)
    fail(s, -3, 'http://a.invalid/')
    fail(s, -202, 'https://bad.example/')
    s.shown.url = 'http://before.example/'
    s.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://a.invalid/', true)
    expect(s.asks).toHaveLength(0)

    const claimed = setup(true)
    watchLoadErrors(claimed.contents as unknown as WebContents, claimed.deps)
    fail(claimed, -102, 'https://upgraded.example/')
    expect(claimed.asks).toHaveLength(0)
  })

  it('stays out for a blocked file the tab is about to move to the session it belongs in, and asks the tab\'s own partition', () => {
    const asked: Array<[string | undefined, string, number]> = []
    const s = setup(false, (partition, url, code) => { asked.push([partition, url, code]); return true })
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    fail(s, -20, 'file:///home/u/app/index.html', true, 'ERR_BLOCKED_BY_CLIENT')
    expect(asked).toEqual([['persist:orivon-local-files', 'file:///home/u/app/index.html', -20]])
    expect(s.asks).toHaveLength(0)

    const stays = setup(false, () => false)
    watchLoadErrors(stays.contents as unknown as WebContents, stays.deps)
    fail(stays, -20, 'file:///home/u/app/index.html', true, 'ERR_BLOCKED_BY_CLIENT')
    expect(stays.asks).toHaveLength(1)
  })

  it('marks a load that Orivon cancelled before sending it with the reason, and only that one', () => {
    const s = setup()
    const refused = new Map<string, LoadRefusal>()
    ;(s.deps as { refused?: (id: number, url: string) => LoadRefusal | undefined }).refused = (id, url) => refused.get(`${String(id)} ${url}`)
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    refused.set('7 http://abc.onion/', 'onion')
    refused.set('7 https://name.eth/', 'would-see')
    refused.set('7 https://slow.eth/', 'unsure')
    refused.set('7 http://plain.eth/', 'plain')
    for (const url of ['http://abc.onion/', 'https://name.eth/', 'https://slow.eth/', 'http://plain.eth/', 'http://other.example/']) fail(s, -20, url, true, 'ERR_BLOCKED_BY_CLIENT')
    expect(s.asks.map((ask) => ask.payload)).toEqual([
      { code: -20, name: 'ERR_BLOCKED_BY_CLIENT', refusal: 'onion' },
      { code: -20, name: 'ERR_BLOCKED_BY_CLIENT', refusal: 'would-see' },
      { code: -20, name: 'ERR_BLOCKED_BY_CLIENT', refusal: 'unsure' },
      { code: -20, name: 'ERR_BLOCKED_BY_CLIENT', refusal: 'plain' },
      { code: -20, name: 'ERR_BLOCKED_BY_CLIENT' }
    ])
  })

  it('marks a failed secure connection with the word the name relay noted for it, and only that one', () => {
    const s = setup()
    const noted = new Map<string, RefusalWord>([['https://gone.example/', 'not-found'], ['https://slow.example/', 'no-answer']])
    ;(s.deps as { relay?: (url: string, code: number) => RefusalWord | undefined }).relay = (url, code) => code === -111 ? noted.get(url) : undefined
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    for (const [url, code] of [['https://gone.example/', -111], ['https://slow.example/', -111], ['https://gone.example/', -105], ['https://other.example/', -111]] as const) fail(s, code, url, true, 'ERR_TUNNEL_CONNECTION_FAILED')
    expect(s.asks.map((ask) => ask.payload)).toEqual([
      { code: -111, name: 'ERR_TUNNEL_CONNECTION_FAILED', relay: 'not-found' },
      { code: -111, name: 'ERR_TUNNEL_CONNECTION_FAILED', relay: 'no-answer' },
      { code: -105, name: 'ERR_TUNNEL_CONNECTION_FAILED' },
      { code: -111, name: 'ERR_TUNNEL_CONNECTION_FAILED' }
    ])
  })

  it('passes no error name that is not one of Chromium\'s', () => {
    const s = setup()
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    fail(s, -105, 'http://a.invalid/', true, '<img src=x>')
    expect(s.asks[0]?.payload).toEqual({ code: -105, name: '' })
  })

  it('withdraws the sheet when the tab navigates again, and replaces it on a second failure', () => {
    const s = setup()
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    fail(s, -105, 'http://a.invalid/')
    s.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(s.cancel).not.toHaveBeenCalled()
    s.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(s.cancel).toHaveBeenCalledOnce()
    fail(s, -102, 'http://127.0.0.1:1/')
    expect(s.asks).toHaveLength(2)
  })

  it('takes the sheet away when other web contents take the tab\'s place, and only that web contents\' sheet', () => {
    const s = setup()
    const other = setup()
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    watchLoadErrors(other.contents as unknown as WebContents, other.deps)
    fail(s, -105, 'http://a.invalid/')
    fail(other, -105, 'http://b.invalid/')
    forgetLoadErrors(s.contents as unknown as WebContents)
    expect(s.cancel).toHaveBeenCalledOnce()
    expect(other.cancel).not.toHaveBeenCalled()
    forgetLoadErrors(new EventEmitter() as unknown as WebContents)
    expect(other.cancel).not.toHaveBeenCalled()
  })

  it('watches a web contents once', () => {
    const s = setup()
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    watchLoadErrors(s.contents as unknown as WebContents, s.deps)
    fail(s, -105, 'http://a.invalid/')
    expect(s.asks).toHaveLength(1)
  })
})

describe('the load-error overlay', () => {
  function setup (): { handler: OverlayHandler, close: ReturnType<typeof vi.fn>, reload: ReturnType<typeof vi.fn>, state: { active: string } } {
    const state = { active: 't1' }
    const reload = vi.fn()
    const window = { tabs: { getState: () => ({ activeTabId: state.active, tabs: [{ id: 't1', displayUrl: 'unresolvable.invalid' }] }), reload } }
    const close = vi.fn()
    const handler = loadErrorOverlay.attach({ window, services: {}, send: vi.fn(), close } as unknown as OverlayWindow)
    return { handler, close, reload, state }
  }

  it('is a centred bar sheet that a tab switch hides and a click elsewhere leaves alone', () => {
    expect(loadErrorOverlay).toMatchObject({ name: 'load-error', placement: { kind: 'area', at: 'center', width: 420 }, focus: 'take', layer: 'bar' })
    expect(loadErrorOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
  })

  it('draws the sentence for the code and the tab\'s own address, and nothing a page could have written', () => {
    const s = setup()
    expect(s.handler.show?.({ code: -105, name: 'ERR_NAME_NOT_RESOLVED', title: 'Send money' })).toEqual({
      title: 'This site can\'t be reached',
      body: 'No server answers to this name. Check the address for a typing mistake.',
      address: 'unresolvable.invalid',
      name: 'ERR_NAME_NOT_RESOLVED'
    })
    for (const bad of [undefined, null, {}, { code: 0, name: '' }, { code: 3, name: '' }, { code: -1.5, name: '' }, { code: '-105', name: '' }, { code: -105, name: 'nope' }]) expect(s.handler.show?.(bad), JSON.stringify(bad)).toBeUndefined()
  })

  it('draws the sentence of the reason the watcher gives for a load Orivon cancelled, and the ordinary one for anything else', () => {
    const s = setup()
    for (const refusal of ['onion', 'would-see', 'unsure', 'plain'] as const) {
      expect(s.handler.show?.({ code: -20, name: 'ERR_BLOCKED_BY_CLIENT', refusal }), refusal).toEqual({ ...loadErrorText(-20, refusal), address: 'unresolvable.invalid', name: 'ERR_BLOCKED_BY_CLIENT' })
    }
    for (const refusal of ['yes', true, 'proxy', 7, null]) expect(s.handler.show?.({ code: -20, name: '', refusal }), String(refusal)).toMatchObject(loadErrorText(-20))
  })

  it('draws the sentence of the word the relay noted, naming the provider the lookups ask, and ignores a word that is not one of its own', () => {
    const s = setup()
    setNameRelayStatusSource(() => nameRelayStatus({ enabled: true, heldToNym: false, active: true, listening: true, resolverHeld: true, provider: 'cloudflare', refused: Object.fromEntries(REFUSAL_WORDS.map((word) => [word, 0])) as Record<RefusalWord, number> }))
    expect(s.handler.show?.({ code: -111, name: 'ERR_TUNNEL_CONNECTION_FAILED', relay: 'no-answer' })).toEqual({
      title: 'This site can\'t be reached',
      body: refusalSentence('no-answer', 'Cloudflare'),
      address: 'unresolvable.invalid',
      name: 'ERR_TUNNEL_CONNECTION_FAILED'
    })
    setNameRelayStatusSource(undefined)
    expect(s.handler.show?.({ code: -111, name: '', relay: 'no-answer' })).toMatchObject({ body: refusalSentence('no-answer', 'Quad9') })
    for (const relay of ['onion', 'yes', 3, null]) expect(s.handler.show?.({ code: -111, name: '', relay }), String(relay)).toMatchObject(loadErrorText(-111))
  })

  it('tries the tab again and closes', () => {
    const s = setup()
    s.handler.show?.({ code: -105, name: '' })
    s.handler.request({ type: 'retry' })
    expect(s.close).toHaveBeenCalledOnce()
    expect(s.reload).toHaveBeenCalledWith('t1')
  })

  it('does nothing for another command, or once another tab is in front', () => {
    const s = setup()
    s.handler.show?.({ code: -105, name: '' })
    for (const bad of [{ type: 'back' }, { type: 'retry', id: 't2' }, 'retry', null]) s.handler.request(bad)
    s.state.active = 't2'
    s.handler.request({ type: 'retry' })
    expect(s.reload).not.toHaveBeenCalled()
    expect(s.close).not.toHaveBeenCalled()
  })
})
