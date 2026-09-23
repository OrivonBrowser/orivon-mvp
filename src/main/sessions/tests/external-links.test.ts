import { describe, expect, it, vi } from 'vitest'
import { askableScheme, createExternalLinks, type ExternalLinkQuestion } from '../external-links.js'
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
  it('asks, in the window showing the tab, naming the scheme, the whole URL and the requesting origin', async () => {
    const { request, confirm } = setup()
    const tab = fakeTab()

    expect(await request(tab, { externalURL: 'mailto:someone@example.com', requestingUrl: PAGE })).toBe(true)
    expect(confirm).toHaveBeenCalledWith(WINDOW, { scheme: 'mailto', url: 'mailto:someone@example.com', origin: 'https://shop.example' })
  })

  it('opens nothing the person cancels', async () => {
    const { request } = setup(vi.fn(async () => false))
    expect(await request(fakeTab(), { externalURL: 'magnet:?xt=urn:btih:00', requestingUrl: PAGE })).toBe(false)
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
