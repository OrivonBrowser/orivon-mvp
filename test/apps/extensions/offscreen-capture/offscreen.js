// Fixture offscreen page. Mirrors Volume Master's own real offscreen.js:
// getUserMedia() with the capture stream id, then a Web Audio graph that
// actually plays the captured audio (so a real 'media-started-playing'
// fires on this page's own webContents -- the signal
// tab-capture.ts's own safety net waits for). window.__lastTrack is read
// directly by the e2e test, independent of chrome.runtime's own
// promise-settling.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.cmd !== 'start-capture') return undefined
  ;(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.mediaStreamId } }
      })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      source.connect(ctx.destination)
      window.__lastStream = stream
      window.__lastTrack = stream.getAudioTracks()[0]
      sendResponse({ ok: true, trackLabel: window.__lastTrack.label, trackReadyState: window.__lastTrack.readyState })
    } catch (error) {
      sendResponse({ ok: false, error: String(error) })
    }
  })()
  return true
})
