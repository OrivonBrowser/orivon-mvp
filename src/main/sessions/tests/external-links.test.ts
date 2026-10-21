import { describe, expect, it, vi } from 'vitest'
import { askableScheme, createExternalLinks, isHandableScheme, MAX_ROUTED_URL_LENGTH, type AppLinkOption, type ExternalLinkQuestion, type LinkAnswer, type LinkRouting } from '../external-links.js'
import { tabPromptState } from '../tab-prompts.js'
import { fakeTab } from './fake-tab.js'

const WINDOW = { id: 'window' }
const PAGE = 'https://shop.example/checkout'

describe('askableScheme', () => {
  // The schemes pages open for real: mail, phone, torrents, wallets.
  it('offers the schemes a web page hands to another app', () => {
    const cases: Array<[string, string]> = [
      ['mailto:someone@example.com?subject=hi', 'mailto'],
      ['tel:+15555550100', 'tel'],
      ['magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', 'magnet'],
      ['bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?amount=1', 'bitcoin'],
      ['ethereum:0x0000000000000000000000000000000000000000', 'ethereum'],
      ['sms:+15555550100', 'sms'],
      ['zoommtg://zoom.us/join?confno=1', 'zoommtg'],
      ['MAILTO:someone@example.com', 'mailto']
    ]
    for (const [url, scheme] of cases) expect(askableScheme(url), url).toBe(scheme)
  })

  // The browser's own schemes, and the ones that reach local files or run
  // code, are never the OS's business. Some can never arrive here in
  // practice; the check does not depend on that.
  it('never offers a scheme that belongs to the browser, to a file, or to script', () => {
    for (const url of [
      'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'blob:https://a.example/uuid',
      'chrome://settings', 'chrome-extension://abc/page.html', 'chrome-untrusted://x', 'devtools://devtools/x',
      'about:blank', 'view-source:https://a.example', 'filesystem:https://a.example/temporary/x',
      'http://a.example', 'https://a.example', 'ws://a.example', 'wss://a.example',
      'orivon://settings', 'orivon-app://x'
    ]) expect(askableScheme(url), url).toBeNull()
  })

  it("never offers a protocol's address scheme, which loads in the browser whatever app claims it", () => {
    for (const url of ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/', 'ipns://docs.ipfs.tech', 'IPFS://not-even-a-cid']) {
      expect(askableScheme(url), url).toBeNull()
    }
  })

  // Chrome's own list of handlers that must never be launched from a page,
  // plus the two Windows handlers that turned a click into code execution.
  it('never offers a scheme whose OS handler is known to run code', () => {
    for (const scheme of ['vbscript', 'shell', 'hcp', 'ms-help', 'mk', 'res', 'mhtml', 'ms-msdt', 'search-ms', 'afp', 'disk', 'disks', 'ie.http', 'livescript', 'msdaipp', 'vnd.ms.radio']) {
      expect(askableScheme(`${scheme}:x`), scheme).toBeNull()
    }
  })

  it('offers nothing for a string that is not a URL', () => {
    for (const url of ['', 'not a url', '://x', '1abc:x']) expect(askableScheme(url), url).toBeNull()
  })

  it('offers a magnet link only when its grammar is a BitTorrent one', () => {
    const HEX = '0123456789abcdef0123456789abcdef01234567'
    const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    for (const url of [
      `magnet:?xt=urn:btih:${HEX}`,
      `magnet:?xt=urn:btih:${HEX.toUpperCase()}`,
      `magnet:?xt=urn:btih:${BASE32}`,
      `magnet:?xt=urn:btih:${BASE32.toLowerCase()}`,
      `magnet:?xt=urn:btih:${HEX}&dn=Movie&tr=https://tracker.example/announce&tr=udp://tracker2.example:80`,
      `magnet:?xt=urn:btmh:1220${HEX}${HEX.slice(0, 24)}`,
      `magnet:?xt=urn:btih:${HEX}&xt=urn:btmh:1220${HEX}${HEX.slice(0, 24)}&x.pe=192.0.2.1:6881`
    ]) expect(askableScheme(url), url).toBe('magnet')

    for (const url of [
      'magnet:?xt=urn:btih:00', // too short
      `magnet:?xt=urn:btih:${'g'.repeat(40)}`, // not hex, not base32
      'magnet:?dn=Movie', // no xt at all
      `magnet:?xt=urn:btih:${HEX}&xt=urn:btih:${HEX}`, // two v1 topics
      `magnet:?xt=urn:btmh:1220${HEX}`, // a v2 hash too short
      `magnet:?xt=urn:sha1:${HEX}`, // not btih
      `magnet:foo?xt=urn:btih:${HEX}`, // a path before the query
      `magnet:?xt=urn:btih:${HEX}&exec=rm+-rf+/` // a parameter outside the known set
    ]) expect(askableScheme(url), url).toBeNull()
  })
})

function setup (confirm = vi.fn(async (_window: unknown, _question: ExternalLinkQuestion) => true)): {
  request: ReturnType<typeof createExternalLinks<typeof WINDOW>>
  confirm: typeof confirm
  windowShowing: ReturnType<typeof vi.fn>
} {
  const windowShowing = vi.fn((): typeof WINDOW | undefined => WINDOW)
  return { request: createExternalLinks({ windowShowing, confirm }), confirm, windowShowing }
}

describe('createExternalLinks', () => {
  it('asks in the tab that showed it, in the window showing it, naming the scheme, the whole URL and the requesting origin', async () => {
    const { request, confirm } = setup()
    const tab = fakeTab()

    expect(await request(tab, { externalURL: 'mailto:someone@example.com', requestingUrl: PAGE })).toBe(true)
    expect(confirm).toHaveBeenCalledWith(WINDOW, { scheme: 'mailto', url: 'mailto:someone@example.com', origin: 'https://shop.example' }, tab)
  })

  it('opens nothing the person cancels', async () => {
    const { request } = setup(vi.fn(async () => false))
    expect(await request(fakeTab(), { externalURL: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', requestingUrl: PAGE })).toBe(false)
  })

  it('refuses without asking for a scheme it never offers, or a request with nothing to open', async () => {
    const { request, confirm } = setup()
    expect(await request(fakeTab(), { externalURL: 'file:///etc/passwd', requestingUrl: PAGE })).toBe(false)
    expect(await request(fakeTab(), { requestingUrl: PAGE })).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  // The question names who is asking; a page with no web origin (a file,
  // a data: URL) could not be named, so it is not asked for.
  it('refuses without asking when the requesting page has no origin to name', async () => {
    const { request, confirm } = setup()
    for (const requestingUrl of ['file:///home/person/page.html', 'data:text/html,x', 'about:blank', undefined]) {
      expect(await request(fakeTab(), { externalURL: 'mailto:a@example.com', requestingUrl })).toBe(false)
    }
    expect(confirm).not.toHaveBeenCalled()
  })

  // A background tab asking would put a question on screen over a page it
  // did not come from.
  it('refuses without asking when the tab is not the one on screen', async () => {
    const { request, confirm, windowShowing } = setup()
    windowShowing.mockReturnValue(undefined)
    expect(await request(fakeTab(), { externalURL: 'mailto:a@example.com', requestingUrl: PAGE })).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks one question at a time per tab, refusing the rest while it is open', async () => {
    let answer: (open: boolean) => void = () => {}
    const { request, confirm } = setup(vi.fn(async () => await new Promise<boolean>((resolve) => { answer = resolve })))
    const tab = fakeTab()

    const first = request(tab, { externalURL: 'mailto:a@example.com', requestingUrl: PAGE })
    tab.touch('mouseDown')
    expect(await request(tab, { externalURL: 'mailto:b@example.com', requestingUrl: PAGE })).toBe(false)
    answer(true)
    expect(await first).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  // A page can open an external link without a click, and Electron asks
  // either way, so without this a page could loop the question. Chrome's
  // own rule: after one launch attempt, the next needs the person to act
  // in the page first.
  it('asks again only after the person has clicked or typed in the page', async () => {
    const { request, confirm } = setup(vi.fn(async () => false))
    const tab = fakeTab()
    const ask = async (): Promise<boolean> => await request(tab, { externalURL: 'tel:+15555550100', requestingUrl: PAGE })

    await ask()
    await ask()
    await ask()
    expect(confirm).toHaveBeenCalledTimes(1)

    tab.touch('mouseMove')
    await ask()
    expect(confirm).toHaveBeenCalledTimes(1)

    tab.touch('mouseDown')
    await ask()
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('treats a prompt that fails as a refusal, and frees the tab for its next question', async () => {
    const { request } = setup(vi.fn(async () => { throw new Error('window gone') }))
    const tab = fakeTab()
    expect(await request(tab, { externalURL: 'mailto:a@example.com', requestingUrl: PAGE })).toBe(false)
    expect(tabPromptState(tab).prompting).toBe(false)
  })
})

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
const TORRENT_APP: AppLinkOption = { origin: 'https://torrent.example', name: 'Torrents' }
const OTHER_APP: AppLinkOption = { origin: 'https://other.example', name: 'Other' }

function routed (options: { apps?: readonly AppLinkOption[], fallback?: string, answer?: LinkAnswer } = {}): {
  request: ReturnType<typeof createExternalLinks<typeof WINDOW>>
  routing: { [K in keyof LinkRouting<typeof WINDOW>]: ReturnType<typeof vi.fn> }
  confirm: ReturnType<typeof vi.fn>
} {
  const routing = {
    appsFor: vi.fn(async () => options.apps ?? [TORRENT_APP]),
    defaultAmong: vi.fn((): string | undefined => options.fallback),
    choose: vi.fn(async (): Promise<LinkAnswer> => options.answer ?? { kind: 'cancel' }),
    remember: vi.fn(),
    open: vi.fn()
  }
  const confirm = vi.fn(async () => true)
  const request = createExternalLinks({ windowShowing: () => WINDOW, confirm, routing: () => routing as unknown as LinkRouting<typeof WINDOW> })
  return { request, routing, confirm }
}

describe('isHandableScheme', () => {
  it('is the scheme half of askableScheme: nothing the browser serves, nothing that runs code', () => {
    expect(isHandableScheme('magnet')).toBe(true)
    for (const scheme of ['http', 'https', 'file', 'javascript', 'data', 'orivon', 'orivon-app', 'ipfs', 'Magnet', '', '1x']) expect(isHandableScheme(scheme), scheme).toBe(false)
  })
})

describe('createExternalLinks with apps that declare the scheme', () => {
  it('asks the system question alone when no app declares the scheme', async () => {
    const { request, routing, confirm } = routed({ apps: [] })
    expect(await request(fakeTab(), { externalURL: MAGNET, requestingUrl: PAGE })).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(routing.choose).not.toHaveBeenCalled()
  })

  it('offers the apps, and hands the link to the one the person picks without asking the system', async () => {
    const { request, routing, confirm } = routed({ apps: [TORRENT_APP, OTHER_APP], answer: { kind: 'app', origin: OTHER_APP.origin, remember: false } })
    const tab = fakeTab()
    expect(await request(tab, { externalURL: MAGNET, requestingUrl: PAGE })).toBe(false)
    expect(routing.choose).toHaveBeenCalledWith(WINDOW, { scheme: 'magnet', url: MAGNET, origin: 'https://shop.example' }, [TORRENT_APP, OTHER_APP], tab)
    expect(routing.open).toHaveBeenCalledWith(OTHER_APP.origin, MAGNET, tab)
    expect(routing.remember).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('remembers the app as the default only when the person ticked Always', async () => {
    const { request, routing } = routed({ answer: { kind: 'app', origin: TORRENT_APP.origin, remember: true } })
    await request(fakeTab(), { externalURL: MAGNET, requestingUrl: PAGE })
    expect(routing.remember).toHaveBeenCalledWith('magnet', TORRENT_APP.origin)
  })

  it('lets the system open the link when the person picks it, and nothing when they cancel', async () => {
    expect(await routed({ answer: { kind: 'system' } }).request(fakeTab(), { externalURL: MAGNET, requestingUrl: PAGE })).toBe(true)
    const cancelled = routed({ answer: { kind: 'cancel' } })
    expect(await cancelled.request(fakeTab(), { externalURL: MAGNET, requestingUrl: PAGE })).toBe(false)
    expect(cancelled.routing.open).not.toHaveBeenCalled()
  })

  it('hands the link to the default app with no question', async () => {
    const { request, routing, confirm } = routed({ fallback: TORRENT_APP.origin })
    const tab = fakeTab()
    expect(await request(tab, { externalURL: MAGNET, requestingUrl: PAGE })).toBe(false)
    expect(routing.choose).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(routing.open).toHaveBeenCalledWith(TORRENT_APP.origin, MAGNET, tab)
  })

  // The default skips the question, so a page could loop the delivery as it could the question.
  it('delivers to the default app again only after the person has acted in the page', async () => {
    const { request, routing } = routed({ fallback: TORRENT_APP.origin })
    const tab = fakeTab()
    await request(tab, { externalURL: MAGNET, requestingUrl: PAGE })
    await request(tab, { externalURL: MAGNET, requestingUrl: PAGE })
    expect(routing.open).toHaveBeenCalledTimes(1)
    tab.touch('mouseDown')
    await request(tab, { externalURL: MAGNET, requestingUrl: PAGE })
    expect(routing.open).toHaveBeenCalledTimes(2)
  })

  it('never offers apps a link that is malformed or longer than an app is handed', async () => {
    const { request, routing, confirm } = routed()
    expect(await request(fakeTab(), { externalURL: 'magnet:?xt=urn:btih:nothex', requestingUrl: PAGE })).toBe(false)
    expect(routing.appsFor).not.toHaveBeenCalled()
    const long = `mailto:a@example.com?body=${'x'.repeat(MAX_ROUTED_URL_LENGTH)}`
    expect(await request(fakeTab(), { externalURL: long, requestingUrl: PAGE })).toBe(true)
    expect(routing.appsFor).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('treats a failing lookup as a refusal', async () => {
    const { request, routing } = routed()
    routing.appsFor.mockRejectedValue(new Error('broker gone'))
    expect(await request(fakeTab(), { externalURL: MAGNET, requestingUrl: PAGE })).toBe(false)
  })
})
