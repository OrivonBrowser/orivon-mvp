import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { EMBED_SCRIPT_CHANNEL } from '../main/channels.js'

// Loaded by every page an app shows inside itself (ADR-0039), and by
// nothing else: src/main/embed/embed-host.ts sets it on the guest at
// attach, whatever `preload` the app's `<webview>` named. It exposes no
// `orivon.*` -- a shown page is another site's document, not the app -- and
// does one thing: runs the script the app set with
// `orivon.web.setEmbedScript`, before the page's own code, in the page's
// main world.

/** What the app's script receives as `orivonEmbed`: the two halves of the element's own `send`/`ipc-message` channel. */
interface EmbedBridge {
  sendToHost: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => void
}

const BRIDGE_GLOBAL = '__orivonEmbedBridge'

/**
 * Runs `source` in the main world. Two steps, because neither alone reaches
 * it: `executeInMainWorld` runs synchronously and carries the bridge across
 * the context boundary, but only a function written here; `webFrame.
 * executeJavaScript` runs any source, whatever the page's own Content-
 * Security-Policy says, but carries nothing across. So the bridge is placed
 * on the page's global under a configurable name first, and the wrapper
 * takes it back off before the app's script sees the page.
 */
function runPageScript (source: string): void {
  const bridge: EmbedBridge = {
    sendToHost: (channel, ...args) => {
      if (typeof channel !== 'string') return
      ipcRenderer.sendToHost(channel, ...args)
    },
    on: (channel, listener) => {
      if (typeof channel !== 'string' || typeof listener !== 'function') return
      ipcRenderer.on(channel, (_event, ...args) => { listener(...args) })
    }
  }
  contextBridge.executeInMainWorld({
    func: (name: string, api: EmbedBridge) => {
      Object.defineProperty(globalThis, name, { value: api, writable: true, configurable: true, enumerable: false })
    },
    args: [BRIDGE_GLOBAL, bridge]
  })
  const wrapper = `(function () {
  var orivonEmbed = globalThis[${JSON.stringify(BRIDGE_GLOBAL)}];
  delete globalThis[${JSON.stringify(BRIDGE_GLOBAL)}];
  (function (orivonEmbed) {
${source}
  }).call(undefined, orivonEmbed);
})();`
  webFrame.executeJavaScript(wrapper).catch((error: unknown) => {
    console.error('[orivon] the script this app runs in the pages it shows threw:', error)
  })
}

const reply = ipcRenderer.sendSync(EMBED_SCRIPT_CHANNEL) as { source?: unknown } | null
if (reply !== null && typeof reply === 'object' && typeof reply.source === 'string' && reply.source !== '') {
  runPageScript(reply.source)
}
