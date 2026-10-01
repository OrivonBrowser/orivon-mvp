// The Reader view command, with the Electron objects it runs on: the page's isolated world for the article,
// the source tab's session for its pictures, the reader pages for what they are told.
import { showToast } from '../page-tools/toast.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { extractArticle } from './reader-extract.js'
import { toggleReader } from './reader-runner.js'
import { readerArticles } from './reader-store.js'

export function readerCommand (target: ShellWindow, services: ShellServices): void {
  void toggleReader(target.tabs, target.tabs, {
    articles: readerArticles,
    extract: extractArticle,
    fetcher: (wc) => async (url, init) => await wc.session.fetch(url, init),
    publish: (topic, payload) => { services.internalPages.publish(topic, payload, ['reader']) },
    notify: (code) => { showToast(target, code) }
  }).catch((error: unknown) => { console.error('[reader] could not open reader view', error) })
}
