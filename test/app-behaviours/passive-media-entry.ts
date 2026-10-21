// Bundled by ./e2e-app-passive-media.test.ts into the fixture app's script: an `<audio>` element made from a script,
// muted, never played and never put in the page, so it loads its source and settles without a sound. It answers with
// the first thing that happens to it, so the test can say whether the source loaded.

export interface Loaded {
  /** `canplay` when enough of the source arrived to play it, `error` when the load was refused or failed, `timeout` when neither happened. */
  readonly event: 'canplay' | 'error' | 'timeout'
  /** The `MediaError` code on `error` (4 is "source not supported or not reachable"). */
  readonly code?: number
}

const TIMEOUT_MS = 8_000

async function load (url: string): Promise<Loaded> {
  return await new Promise((resolve) => {
    const audio = new Audio()
    audio.muted = true
    audio.preload = 'auto'
    const timer = setTimeout(() => { resolve({ event: 'timeout' }); audio.removeAttribute('src') }, TIMEOUT_MS)
    audio.addEventListener('canplay', () => { clearTimeout(timer); resolve({ event: 'canplay' }) }, { once: true })
    audio.addEventListener('error', () => { clearTimeout(timer); resolve({ event: 'error', ...(audio.error === null ? {} : { code: audio.error.code }) }) }, { once: true })
    audio.src = url
    audio.load()
  })
}

;(globalThis as unknown as { passiveMediaE2e: unknown }).passiveMediaE2e = { load }
