// Asks for the devices the e2e test names and keeps the outcome on `window.__media`, where the test reads it. A
// page asks with `window.__ask({ video: true })`; the tracks are stopped at once, so nothing keeps a device open.
window.__ask = async (constraints) => {
  window.__media = undefined
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const tracks = stream.getTracks().map((track) => ({ kind: track.kind, readyState: track.readyState }))
    stream.getTracks().forEach((track) => { track.stop() })
    window.__media = { ok: true, tracks }
  } catch (error) {
    window.__media = { ok: false, name: error.name }
  }
  return window.__media
}
