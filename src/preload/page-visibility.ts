import { contextBridge, ipcRenderer } from 'electron'
import { TAB_VISIBILITY_CHANNEL } from '../main/channels.js'

// A tab that is not in front is taken off its window, and Electron never tells such a view it is hidden:
// without this the page reads `document.visibilityState === 'visible'` for ever and never backs off. The
// shell says when the tab is out of sight (src/main/shell/tab-visibility.ts); this makes the page's own
// `visibilityState`, `hidden` and their `webkit` twins answer for it and fires `visibilitychange`.
//
// Top frame only, as the rest of the ordinary-tab surface: a subframe keeps the browser's own answer.

const PROPERTIES: readonly string[] = ['visibilityState', 'hidden', 'webkitVisibilityState', 'webkitHidden']

/**
 * Runs in the page's MAIN world through contextBridge.executeInMainWorld, before the page's scripts, so it is
 * self-contained: it closes over nothing from this module. The flag lives in this closure; the only way to
 * change it is an event named by `channel`, a name made fresh for each document and told to no page script.
 * Each getter defers to the browser's own for any document but the page's, and while the tab is shown.
 */
function installInMainWorld (channel: string, properties: readonly string[]): void {
  const proto = Document.prototype
  let hidden = false
  const answers = new Set<string>()
  for (const name of properties) {
    const native = Object.getOwnPropertyDescriptor(proto, name)
    const nativeGet = native?.get
    if (native === undefined || nativeGet === undefined) continue
    const isState = name.endsWith('State')
    // A getter literal with a computed key is named `get <name>`, as the browser's own is.
    const named = { get [name] (): unknown { return hidden && (this as unknown) === document ? (isState ? 'hidden' : true) : nativeGet.call(this) } }
    const get = Object.getOwnPropertyDescriptor(named, name)?.get
    if (get === undefined) continue
    Object.defineProperty(proto, name, { ...native, get })
    answers.add(name)
  }
  if (answers.size === 0) return
  document.addEventListener(channel, (event) => {
    const next = (event as CustomEvent).detail === true
    if (next === hidden) return
    hidden = next
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  })
}

/** Main world again: hands the shell's answer to the listener `installInMainWorld` left. */
function announceInMainWorld (channel: string, hidden: boolean): void {
  document.dispatchEvent(new CustomEvent(channel, { detail: hidden }))
}

function freshChannel (): string {
  const words = crypto.getRandomValues(new Uint32Array(4))
  return `orivon-visibility-${Array.from(words, (word) => word.toString(36)).join('')}`
}

/** Fail-open like the other main-world installers: `executeInMainWorld` is `@experimental`, and a page that
 * keeps the browser's answers is degraded (it never backs off), not broken. */
export function installPageVisibility (): void {
  const channel = freshChannel()
  try {
    contextBridge.executeInMainWorld({ func: installInMainWorld, args: [channel, PROPERTIES] })
  } catch (error) {
    console.error('[orivon] page visibility not installed', error)
    return
  }
  ipcRenderer.on(TAB_VISIBILITY_CHANNEL, (_event, hidden: unknown) => {
    if (typeof hidden !== 'boolean') return
    try {
      contextBridge.executeInMainWorld({ func: announceInMainWorld, args: [channel, hidden] })
    } catch (error) {
      console.error('[orivon] page visibility not announced', error)
    }
  })
}
