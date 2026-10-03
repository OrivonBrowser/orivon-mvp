import { contextBridge, ipcRenderer } from 'electron'
import { TAB_VISIBILITY_CHANNEL } from '../main/channels.js'

// A tab that is not in front is taken off its window, and Electron never tells such a view it is hidden:
// without this the page reads `document.visibilityState === 'visible'` for ever and never backs off. The
// shell says when the tab is out of sight (src/main/shell/tab-visibility.ts); this makes the page's own
// `visibilityState`, `hidden` and their `webkit` twins answer for it and fires `visibilitychange`.
//
// Top frame only, as the rest of the ordinary-tab surface: a subframe keeps the browser's own answer.

/**
 * Runs in the page's MAIN world through contextBridge.executeInMainWorld, before the page's scripts, so it is
 * self-contained: it closes over nothing from this module. The flag lives in this closure; the only way to
 * change it is an event named by `channel`, a name made fresh for each document and told to no page script.
 * Each getter defers to the browser's own for any document but the page's, and while the tab is shown. The
 * four properties are named literally, one `defineProperty` each, so check:page-globals can read every call.
 */
function installInMainWorld (channel: string): void {
  const proto = Document.prototype
  let hidden = false
  /** The browser's own descriptor for `name` with only its getter replaced, or undefined where it has none. */
  const answering = (name: string, whenHidden: unknown): PropertyDescriptor | undefined => {
    const native = Object.getOwnPropertyDescriptor(proto, name)
    const nativeGet = native?.get
    if (native === undefined || nativeGet === undefined) return undefined
    // A getter literal with a computed key is named `get <name>`, as the browser's own is.
    const named = { get [name] (): unknown { return hidden && (this as unknown) === document ? whenHidden : nativeGet.call(this) } }
    const get = Object.getOwnPropertyDescriptor(named, name)?.get
    return get === undefined ? undefined : { ...native, get }
  }
  const visibilityState = answering('visibilityState', 'hidden')
  const hiddenFlag = answering('hidden', true)
  const webkitVisibilityState = answering('webkitVisibilityState', 'hidden')
  const webkitHidden = answering('webkitHidden', true)
  if (visibilityState !== undefined) Object.defineProperty(proto, 'visibilityState', visibilityState)
  if (hiddenFlag !== undefined) Object.defineProperty(proto, 'hidden', hiddenFlag)
  if (webkitVisibilityState !== undefined) Object.defineProperty(proto, 'webkitVisibilityState', webkitVisibilityState)
  if (webkitHidden !== undefined) Object.defineProperty(proto, 'webkitHidden', webkitHidden)
  if (visibilityState === undefined && hiddenFlag === undefined && webkitVisibilityState === undefined && webkitHidden === undefined) return
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
    contextBridge.executeInMainWorld({ func: installInMainWorld, args: [channel] })
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
