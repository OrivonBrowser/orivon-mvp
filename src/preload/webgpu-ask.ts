// WebGPU for a page in a tab (ADR-0106). Electron 44 tells the browser process nothing of a WebGPU request, so the
// question "may this site use your graphics card" can only be asked from the page's own side. The page's
// `GPU.prototype.requestAdapter` is wrapped in its own world: the wrapper makes the real call first, then asks main
// (src/main/site-settings/webgpu-ask-ipc.ts) whether the page may have what came back, saying only whether Chromium
// gave an adapter. The page gets the adapter only when main answers exactly `true`; any other answer, and any failure
// to ask, gives it `null`, which is what a computer without WebGPU gives, so a site's own fallback runs. The wrapper is
// not a boundary: a frame and a worker of the page are not wrapped, and a page that tampers with it only fools itself.
import { contextBridge, ipcRenderer } from 'electron'
import { WEBGPU_ASK_CHANNEL } from '../main/channels.js'
import { inMainFrame } from './frame.js'

/** Asks main whether the page may have an adapter; anything but a plain `true` is no. */
async function ask (adapter: boolean): Promise<boolean> {
  try {
    return await ipcRenderer.invoke(WEBGPU_ASK_CHANNEL, { adapter }) === true
  } catch {
    return false
  }
}

/**
 * Runs in the page's main world through contextBridge.executeInMainWorld, so it closes over nothing from this module.
 * Every native it uses is taken now, before a page script has run, and none is looked up when a call runs: a page whose
 * compartments scuttle their globals (LavaMoat) still gets its answer.
 */
function wrapRequestAdapter (askMain: (adapter: boolean) => Promise<unknown>): void {
  // The interface exists for a secure context only: an insecure page and a blank page have none, and nothing to wrap.
  if (typeof GPU === 'undefined') return
  const owner = GPU.prototype
  const native = Object.getOwnPropertyDescriptor(owner, 'requestAdapter')
  const nativeRequest: unknown = native?.value
  if (native === undefined || typeof nativeRequest !== 'function') return
  const call = Reflect.apply
  const define = Object.defineProperty
  const nativeThen = Promise.prototype.then

  /** The adapter, when main says the page may have it; otherwise null. */
  const settle = (adapter: unknown): unknown => {
    const given = typeof adapter === 'object' && adapter !== null
    try {
      return call(nativeThen, askMain(given), [(allowed: unknown) => allowed === true && given ? adapter : null, () => null])
    } catch {
      return null
    }
  }

  const wrapped = new Proxy(nativeRequest, {
    apply: (target, self: unknown, args: unknown[]) => {
      const result: unknown = call(target, self, args)
      try {
        return call(nativeThen, result as Promise<unknown>, [settle])
      } catch {
        return result
      }
    }
  })
  define(owner, 'requestAdapter', { value: wrapped, writable: native.writable === true, enumerable: native.enumerable === true, configurable: native.configurable === true })
}

/** Top frame only. Fail-open like the other main-world installers: `executeInMainWorld` is `@experimental`, and without the wrapper the page keeps the platform's own call, unasked. */
export function installWebGpuAsk (): void {
  if (!inMainFrame()) return
  try {
    contextBridge.executeInMainWorld({
      func: wrapRequestAdapter,
      args: [(adapter: boolean) => ask(adapter)]
    })
  } catch (error) {
    console.error('[orivon] webgpu requestAdapter not wrapped', error)
  }
}
