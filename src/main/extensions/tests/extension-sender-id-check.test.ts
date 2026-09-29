import { describe, expect, it } from 'vitest'
import { senderMatchesClaimedExtensionId, type MessageEvent } from '../extension-sender-id-check.js'

const REAL_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function frameEvent (url: string): MessageEvent {
  return { type: 'frame', sender: { getURL: () => url } }
}

function workerEvent (scope: string): MessageEvent {
  return { type: 'service-worker', serviceWorker: { scope } }
}

describe('senderMatchesClaimedExtensionId', () => {
  it('allows a message that names no extension id', () => {
    expect(senderMatchesClaimedExtensionId(frameEvent(`chrome-extension://${REAL_ID}/popup.html`), undefined)).toBe(true)
  })

  it('allows a frame naming its own id', () => {
    expect(senderMatchesClaimedExtensionId(frameEvent(`chrome-extension://${REAL_ID}/popup.html`), REAL_ID)).toBe(true)
  })

  it('allows a service worker naming its own id', () => {
    expect(senderMatchesClaimedExtensionId(workerEvent(`chrome-extension://${REAL_ID}/`), REAL_ID)).toBe(true)
  })

  it('refuses a frame naming a different loaded extension\'s id', () => {
    expect(senderMatchesClaimedExtensionId(frameEvent(`chrome-extension://${REAL_ID}/popup.html`), OTHER_ID)).toBe(false)
  })

  it('refuses a service worker naming a different loaded extension\'s id', () => {
    expect(senderMatchesClaimedExtensionId(workerEvent(`chrome-extension://${REAL_ID}/`), OTHER_ID)).toBe(false)
  })

  it('refuses any claim from a sender whose own URL is not a chrome-extension: id', () => {
    expect(senderMatchesClaimedExtensionId(frameEvent('https://example.com/'), REAL_ID)).toBe(false)
  })
})
