import { describe, expect, it } from 'vitest'
import { senderMatchesClaimedExtensionId, type MessageEvent } from '../extension-sender-id-check.js'

const REAL_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function frameEvent (url: string | null): MessageEvent {
  return { type: 'frame', senderFrame: url === null ? null : { url } }
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

  it('refuses a claim naming the id of the extension a compromised iframe merely runs inside: only the SENDING frame\'s own id counts, never the top-level page it is embedded in', () => {
    // A page belonging to REAL_ID embeds an iframe belonging to OTHER_ID
    // (e.g. a web-accessible page). The message comes from that iframe --
    // its own chrome-extension://OTHER_ID/ URL -- but falsely claims the
    // host page's id (REAL_ID). Reading the TOP-LEVEL page's own URL here
    // (the bug this check exists to close) would have matched the claim and
    // let the iframe reach REAL_ID's own handlers; the sending frame's own
    // URL never does.
    expect(senderMatchesClaimedExtensionId(frameEvent(`chrome-extension://${OTHER_ID}/iframe.html`), REAL_ID)).toBe(false)
  })

  it('allows an extension iframe embedded in an ordinary https page, naming its own id', () => {
    // The TOP-LEVEL page here is an ordinary https: page, not a
    // chrome-extension: one at all -- deriving the id from the top page (the
    // bug) would refuse even this legitimate case. The sending frame's own
    // chrome-extension: URL is what is checked, regardless of what it is
    // embedded in.
    expect(senderMatchesClaimedExtensionId(frameEvent(`chrome-extension://${REAL_ID}/iframe.html`), REAL_ID)).toBe(true)
  })

  it('refuses a claim when the sending frame is missing (destroyed before Electron could report it)', () => {
    expect(senderMatchesClaimedExtensionId(frameEvent(null), REAL_ID)).toBe(false)
  })
})
