import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// Drives the REAL ExtensionRouter (crx-msg/crx-msg-remote handlers) together
// with the real senderMatchesClaimedExtensionId, the same way
// router-listener-sender-id.test.ts drives crx-add-listener/
// crx-remove-listener. Reproduces the path browser-action.ts's own
// `preloadOpts = { allowRemote: true, extensionContext: false }` handlers
// (getState/activate/addObserver/removeObserver) are reachable through:
// crx-msg, with no extension context required at all, is meant only to
// arrive from crx-msg-remote's own sender check (the chrome view) -- before
// this suite's own fix, a page belonging to ANY loaded extension could call
// crx-msg directly with no claimed id and reach the same handler, then name
// a completely different extensionId inside its own arguments.
const handles = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { handles.set(channel, fn) }),
    on: vi.fn()
  }
}))

const { ExtensionRouter, setMessageSenderIdCheck, setRemoteMessageSenderCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { senderMatchesClaimedExtensionId } = await import('../extension-sender-id-check.js')

function fakeSession (): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn(() => null) },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

describe('crx-msg with no claimed extension id', () => {
  it('refuses a handler with no extension-context requirement, the same one crx-msg-remote reaches legitimately', async () => {
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    setRemoteMessageSenderCheck(() => true) // production: restricted to the chrome view; here, "is the chrome view"
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const activate = vi.fn(() => 'activated')
    router.apiHandler()('browserAction.activate', activate, { allowRemote: true, extensionContext: false })

    const senderId = 'a'.repeat(32)
    const event = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${senderId}/popup.html` }
    }

    // The exploit: an extension page calls crx-msg directly, naming no id,
    // to reach a handler meant only for the chrome view's crx-msg-remote.
    await expect(
      handles.get('crx-msg')!(event, undefined, 'browserAction.activate', {
        eventType: 'click',
        extensionId: 'b'.repeat(32),
        tabId: 5
      })
    ).rejects.toThrow(/refused/)
    expect(activate).not.toHaveBeenCalled()

    // The legitimate path still works: crx-msg-remote never consults
    // gMessageSenderIdCheck at all. '_self' (DEFAULT_SESSION) resolves to
    // the sender's own session directly, never through resolvePartition
    // (partition.ts's own session.fromPartition, unmocked here).
    const remoteResult = await handles.get('crx-msg-remote')!(
      event,
      '_self',
      'browserAction.activate',
      { eventType: 'click', extensionId: senderId, tabId: 5 }
    )
    expect(remoteResult).toBe('activated')
  })
})
