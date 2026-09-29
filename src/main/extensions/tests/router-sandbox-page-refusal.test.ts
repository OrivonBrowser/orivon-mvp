import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// Drives the REAL ExtensionRouter and the REAL isSandboxPageUrl (UPSTREAM.md
// patch 37), the same way router-crx-msg-sender-id.test.ts and
// router-extension-registration-race.test.ts do. Measured directly against
// a real sandbox.html page (probed with the mv3-full fixture): Electron
// does NOT give a manifest sandbox.pages document an opaque origin the way
// real Chrome's CSP `sandbox` directive does -- location.origin there stays
// the ordinary chrome-extension://<id> origin -- so the manifest-based
// check below is what actually refuses a forged message on this Electron
// build; the opaque-origin check is forward-compatible defence only.
const handles = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { handles.set(channel, fn) }),
    on: vi.fn()
  }
}))

const { ExtensionRouter, isSandboxPageUrl, setMessageSenderIdCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { senderMatchesClaimedExtensionId } = await import('../extension-sender-id-check.js')

const EXT_ID = 'a'.repeat(32)

function fakeSession (manifest: unknown): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn((id: string) => (id === EXT_ID ? { id, manifest } : null)) },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

describe('isSandboxPageUrl', () => {
  it('matches an exact page name', () => {
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/sandbox.html`)).toBe(true)
  })

  it('matches a glob pattern the way Chrome\'s own sandbox.pages grammar does', () => {
    expect(isSandboxPageUrl(['sandbox/*.html'], `chrome-extension://${EXT_ID}/sandbox/one.html`)).toBe(true)
    expect(isSandboxPageUrl(['sandbox/*.html'], `chrome-extension://${EXT_ID}/other/one.html`)).toBe(false)
  })

  it('does not match a page not declared', () => {
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/popup.html`)).toBe(false)
  })

  it('is false for an undefined or empty pages list', () => {
    expect(isSandboxPageUrl(undefined, `chrome-extension://${EXT_ID}/sandbox.html`)).toBe(false)
    expect(isSandboxPageUrl([], `chrome-extension://${EXT_ID}/sandbox.html`)).toBe(false)
  })

  it('is false for a malformed URL, rather than throwing', () => {
    expect(isSandboxPageUrl(['sandbox.html'], 'not a url')).toBe(false)
  })

  it('strips a leading slash from a manifest entry, the way Chrome treats "/sandbox.html" and "sandbox.html" as the same page (UPSTREAM.md patch 39)', () => {
    expect(isSandboxPageUrl(['/sandbox.html'], `chrome-extension://${EXT_ID}/sandbox.html`)).toBe(true)
  })

  it('percent-decodes the URL pathname before matching (UPSTREAM.md patch 39)', () => {
    expect(isSandboxPageUrl(['sandbox page.html'], `chrome-extension://${EXT_ID}/sandbox%20page.html`)).toBe(true)
  })

  it('is false for a pathname with a malformed percent-sequence, rather than comparing it encoded (UPSTREAM.md patch 39)', () => {
    expect(isSandboxPageUrl(['sandbox.html%'], `chrome-extension://${EXT_ID}/sandbox.html%`)).toBe(false)
  })

  it('matches a many-star pattern against a long near-miss string in linear time, not exponential (ReDoS; UPSTREAM.md patch 39)', () => {
    // The classic catastrophic-backtracking shape for the OLD
    // regex-based matcher this replaces: `^a.*a.*a.*a.*a.*a.*a.*a.*b$`
    // against a long run of 'a's with no trailing 'b' forces a regex
    // engine to try every possible split point for every star before
    // giving up. 8 stars, at MAX_STARS_PER_PATTERN -- exercises the real
    // linear matcher, not the cap's own short-circuit above it.
    const pattern = 'a*'.repeat(8) + 'b'
    const pathname = 'a'.repeat(5000)
    const url = `chrome-extension://${EXT_ID}/${pathname}`

    const started = Date.now()
    const result = isSandboxPageUrl([pattern], url)
    const elapsed = Date.now() - started

    expect(result).toBe(false)
    expect(elapsed).toBeLessThan(200)
  })

  it('matches a pattern with many stars just fine -- the matcher is linear, so there is no star cap (UPSTREAM.md patch 41)', () => {
    const manyStars = 'a*'.repeat(20) + 'b'
    expect(isSandboxPageUrl([manyStars], `chrome-extension://${EXT_ID}/${'a'.repeat(50)}b`)).toBe(true)
  })

  it('never silently skips a declared page past some count, however long the pages list (UPSTREAM.md patch 41: the cap moved to extension-manifest.ts, refusing to load such a manifest at all, rather than truncating which of its declared pages this matches)', () => {
    const pages = Array.from({ length: 250 }, (_, i) => `page-${String(i)}.html`)
    pages.push('sandbox.html') // entry 250 -- would have been past the old 200-entry cap
    expect(isSandboxPageUrl(pages, `chrome-extension://${EXT_ID}/sandbox.html`)).toBe(true)
    expect(isSandboxPageUrl(pages, `chrome-extension://${EXT_ID}/page-0.html`)).toBe(true)
  })

  it('strips ALL leading slashes and backslashes, the way Chromium\'s ExtensionURLToRelativeFilePath does before serving the file, not just the first (UPSTREAM.md patch 41)', () => {
    // chrome-extension://<id>//sandbox.html and .../\sandbox.html: Electron
    // (like Chromium) still serves the real sandbox.html for either --
    // stripping only one leading separator left the pathname here as
    // "/sandbox.html", which never equals the manifest's "sandbox.html"
    // pattern, so the real sandboxed page silently got no CSP and no
    // router refusal at all.
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}//sandbox.html`)).toBe(true)
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}///sandbox.html`)).toBe(true)
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/\\sandbox.html`)).toBe(true)
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/\\/\\sandbox.html`)).toBe(true)
  })

  it('a manifest entry with its own extra leading slashes/backslashes still matches (symmetrical stripping)', () => {
    expect(isSandboxPageUrl(['//sandbox.html'], `chrome-extension://${EXT_ID}/sandbox.html`)).toBe(true)
  })

  it('a dot-segment in the URL still matches -- the URL parser itself already collapses "/./" before this function ever sees it', () => {
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/./sandbox.html`)).toBe(true)
  })

  it('matches case-insensitively on win32 and darwin, whose filesystems would still serve the real file for a differently-cased request', () => {
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/SANDBOX.html`, 'win32')).toBe(true)
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/SANDBOX.html`, 'darwin')).toBe(true)
  })

  it('stays case-sensitive on linux, whose filesystem would 404 a differently-cased request rather than serve the real file', () => {
    expect(isSandboxPageUrl(['sandbox.html'], `chrome-extension://${EXT_ID}/SANDBOX.html`, 'linux')).toBe(false)
  })
})

describe('ExtensionRouter.onExtensionMessage refuses a sandboxed page', () => {
  it('refuses a frame whose URL is the extension\'s own declared sandbox.pages entry, even with an ordinary origin', async () => {
    const session = fakeSession({ sandbox: { pages: ['sandbox.html'] } })
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)
    const query = vi.fn()
    router.apiHandler()('tabs.query', query)

    const event = {
      type: 'frame',
      sender: { session },
      // Measured: a real sandbox page's own location.origin is the
      // ordinary chrome-extension://<id> origin on this Electron build,
      // not opaque -- reproduced here deliberately, so this case exercises
      // the manifest-based refusal, not the opaque-origin one.
      senderFrame: { url: `chrome-extension://${EXT_ID}/sandbox.html`, origin: `chrome-extension://${EXT_ID}` }
    }

    await expect(handles.get('crx-msg')!(event, EXT_ID, 'tabs.query')).rejects.toThrow(
      /declared sandbox page/
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('refuses a frame whose URL has the doubled-leading-slash bypass shape too (UPSTREAM.md patch 41)', async () => {
    const session = fakeSession({ sandbox: { pages: ['sandbox.html'] } })
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)
    const query = vi.fn()
    router.apiHandler()('tabs.query', query)

    const event = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${EXT_ID}//sandbox.html`, origin: `chrome-extension://${EXT_ID}` }
    }

    await expect(handles.get('crx-msg')!(event, EXT_ID, 'tabs.query')).rejects.toThrow(
      /declared sandbox page/
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('refuses a frame whose own reported origin is opaque, whatever URL it claims', async () => {
    const session = fakeSession({})
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)
    const query = vi.fn()
    router.apiHandler()('tabs.query', query)

    const event = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${EXT_ID}/popup.html`, origin: 'null' }
    }

    await expect(handles.get('crx-msg')!(event, EXT_ID, 'tabs.query')).rejects.toThrow(
      /opaque origin/
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('still allows an ordinary page not declared as a sandbox page', async () => {
    const session = fakeSession({ sandbox: { pages: ['sandbox.html'] } })
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)
    const query = vi.fn(async () => ['ok'])
    router.apiHandler()('tabs.query', query)

    const event = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${EXT_ID}/popup.html`, origin: `chrome-extension://${EXT_ID}` }
    }

    const result = await handles.get('crx-msg')!(event, EXT_ID, 'tabs.query')
    expect(result).toEqual(['ok'])
    expect(query).toHaveBeenCalledTimes(1)
  })
})
