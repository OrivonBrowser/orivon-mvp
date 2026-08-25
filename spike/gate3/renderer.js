// GATE 3 -- renderer. Plays the fixture MP4 via webtorrent's Service-Worker
// createServer(), streamed into a real <video> element, then seeks and
// measures whether playback resumes without a full re-download.
//
// SW registration under file:// was confirmed to work in this Electron build
// (isSecureContext: true, registration succeeds) via a standalone probe --
// see spike/results/gate-3-sw-probe.json. That result decided this path over
// the more complex protocol.handle() custom-scheme fallback.
import './shim/globals.js'

import WebTorrent from 'webtorrent'
import netShim from 'net'

globalThis.__gate3 = {
  netIsShimmed: () => ({ typeofConnect: typeof netShim?.connect }),

  run: ({ magnetURI, peerAddr, seekFraction = 0.75, timeoutMs = 60000 }) => new Promise((resolve) => {
    const started = performance.now()
    const events = []
    const log = (m) => events.push(`${Math.round(performance.now() - started)}ms ${m}`)

    const video = document.querySelector('#player')
    let client
    let torrent
    let settled = false
    let firstFrameAt = null
    let seekIssuedAt = null
    let downloadedAtSeek = null
    let resumedAt = null
    let downloadedAtResume = null

    const finish = (verdict, extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = {
        verdict,
        events,
        timeToFirstFrameMs: firstFrameAt === null ? null : Math.round(firstFrameAt - started),
        seekIssuedAt: seekIssuedAt === null ? null : Math.round(seekIssuedAt - started),
        resumedAtMs: resumedAt === null ? null : Math.round(resumedAt - started),
        resumeLatencyMs: (resumedAt !== null && seekIssuedAt !== null) ? Math.round(resumedAt - seekIssuedAt) : null,
        downloadedAtSeek,
        downloadedAtResume,
        totalBytes: torrent?.length ?? null,
        finalDownloaded: torrent?.downloaded ?? null,
        duration: video?.duration ?? null,
        currentTime: video?.currentTime ?? null,
        ...extra
      }
      try { client?.destroy() } catch { /* ignore */ }
      resolve(result)
    }

    const timer = setTimeout(() => finish('TIMEOUT'), timeoutMs)

    ;(async () => {
      let controller
      try {
        const reg = await navigator.serviceWorker.register('./sw.min.js', { scope: './' })
        await navigator.serviceWorker.ready
        controller = reg
        log('service worker registered')
      } catch (err) {
        finish('FAIL', { error: `service worker registration failed: ${err.name}: ${err.message}` })
        return
      }

      client = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
      client.on('error', (err) => log(`client error: ${err.message}`))

      try {
        client.createServer({ controller }, 'browser')
      } catch (err) {
        finish('FAIL', { error: `createServer threw: ${String(err)}` })
        return
      }
      log('createServer(controller, "browser") ok')

      torrent = client.add(magnetURI, { announce: [] }, () => log('metadata ready'))

      torrent.on('infoHash', () => {
        log(`infoHash, adding peer ${peerAddr}`)
        torrent.addPeer(peerAddr)
      })

      torrent.on('error', (err) => finish('FAIL', { error: `torrent error: ${err.message}` }))

      torrent.on('metadata', () => {
        const file = torrent.files.find((f) => f.name.endsWith('.mp4'))
        if (!file) {
          finish('FAIL', { error: 'no .mp4 file in torrent' })
          return
        }
        log(`streaming ${file.name} (${file.length} bytes) to <video>`)
        file.streamTo(video)

        video.addEventListener('loadeddata', () => {
          if (firstFrameAt === null) {
            firstFrameAt = performance.now()
            log(`first frame rendered, duration=${video.duration}`)
            void video.play().catch((e) => log(`play() rejected: ${e.message}`))
          }
        })

        video.addEventListener('playing', () => {
          if (seekIssuedAt !== null && resumedAt === null) {
            resumedAt = performance.now()
            downloadedAtResume = torrent.downloaded
            log(`playing resumed after seek, downloaded=${downloadedAtResume}/${torrent.length}`)
            // Give it a moment to render the seeked frame, then finish.
            setTimeout(() => finish('PASS'), 1500)
          }
        })

        video.addEventListener('error', () => {
          finish('FAIL', { error: `video element error: ${video.error?.message ?? 'unknown'}` })
        })

        // Once we have a first frame and a real duration, seek.
        const trySeek = setInterval(() => {
          if (firstFrameAt !== null && video.duration > 0 && seekIssuedAt === null) {
            clearInterval(trySeek)
            seekIssuedAt = performance.now()
            downloadedAtSeek = torrent.downloaded
            const target = video.duration * seekFraction
            log(`seeking to ${target.toFixed(1)}s (${(seekFraction * 100).toFixed(0)}%), downloaded=${downloadedAtSeek}/${torrent.length}`)
            video.currentTime = target
          }
        }, 100)
      })
    })()
  }),

  // Captures the current video frame to a canvas and returns a PNG data URL,
  // so the driver can save it and the frame counter burned into the fixture
  // can be read directly -- proof of WHICH frame is showing, not just that
  // currentTime was set (currentTime can change with nothing decoded).
  captureFrame: () => {
    const video = document.querySelector('#player')
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }
}
