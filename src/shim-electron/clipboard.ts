// `clipboard.writeText` and `clipboard.readText`, the two members a ported app
// reaches for. Electron answers both synchronously; a page can only write
// through `navigator.clipboard`, and can read nothing at all without a
// grant. See README.md's Design notes for what `readText` answers and why.

import { notConsidered, refusingProxy } from './unimplemented.js'

export interface ElectronClipboard {
  writeText(text: string, type?: 'selection' | 'clipboard'): void
  readText(type?: 'selection' | 'clipboard'): string
}

export interface ClipboardDeps {
  /** Where `paste` events are heard: the page's document. */
  readonly document: Pick<EventTarget, 'addEventListener'>
  readonly navigator: { readonly clipboard?: Pick<Clipboard, 'writeText'> }
  readonly warn: (message: string, error?: unknown) => void
}

interface PasteLike extends Event {
  readonly clipboardData?: { getData: (type: string) => string } | null
}

export function createClipboard (deps: ClipboardDeps): ElectronClipboard {
  let pasted = ''
  // Capture phase on the document runs before any listener the app registers, so a listener that
  // stops propagation cannot hide the text. The reset waits a task, not a microtask: the browser
  // runs microtasks between one listener's callback and the next, which would clear the text before
  // the app's own listener asked for it.
  deps.document.addEventListener('paste', (event) => {
    pasted = (event as PasteLike).clipboardData?.getData('text/plain') ?? ''
    setTimeout(() => { pasted = '' }, 0)
  }, true)

  const known: ElectronClipboard = {
    writeText (text) {
      try {
        const written = deps.navigator.clipboard?.writeText(text)
        if (written === undefined) {
          deps.warn('clipboard.writeText: this page has no navigator.clipboard, so nothing was copied')
          return
        }
        written.catch((error: unknown) => { deps.warn('clipboard.writeText: the browser refused the copy', error) })
      } catch (error) {
        deps.warn('clipboard.writeText: the browser refused the copy', error)
      }
    },
    readText () {
      return pasted
    }
  }
  return refusingProxy(known, (prop) => notConsidered(`clipboard.${prop}`))
}
