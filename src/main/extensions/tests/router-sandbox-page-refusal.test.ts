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
