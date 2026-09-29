// Fixture service worker for test/e2e-extensions-offscreen-capture.test.ts.
// Every request/response is JSON, read back from a hidden sender page's own
// chrome.runtime.sendMessage() call -- the same shape Volume Master's real
// service worker uses (each context filters by its own `cmd`/`target`,
// rather than assuming a message is meant for it).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.cmd === 'has-document') {
        sendResponse({ ok: true, result: await chrome.offscreen.hasDocument() })
      } else if (msg.cmd === 'ensure-offscreen') {
        if (!(await chrome.offscreen.hasDocument())) {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'fixture: host a getUserMedia("tab") call'
          })
        }
        sendResponse({ ok: true })
      } else if (msg.cmd === 'get-contexts') {
        sendResponse({ ok: true, contexts: await chrome.runtime.getContexts({}) })
      } else if (msg.cmd === 'capture') {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId })
        const offscreenResult = await chrome.runtime.sendMessage({ cmd: 'start-capture', target: 'offscreen', mediaStreamId: streamId })
        sendResponse({ ok: true, streamId, offscreenResult })
      }
      // An unrecognized cmd (including this worker's own broadcast messages
      // looping back to it) gets no response -- sendMessage resolves
      // undefined for the sender, same as real Chrome with no listener.
    } catch (error) {
      sendResponse({ ok: false, error: String(error) })
    }
  })()
  return true
})
