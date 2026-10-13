// The Reader view command, with the Electron objects it runs on: the page's isolated world for the article,
// the source tab's session for its pictures, the reader pages for what they are told.
import { net } from 'electron'
import { createRequestFetch } from '../../loader/electron/request-fetch.js'
import { answerRouteChallenge } from '../route/lookup-session.js'
import { showToast } from '../page-tools/toast.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { extractArticle } from './reader-extract.js'
import { toggleReader } from './reader-runner.js'
import { readerArticles } from './reader-store.js'

export function readerCommand (target: ShellWindow, services: ShellServices): void {
  void toggleReader(target.tabs, {
    articles: readerArticles,
    extract: extractArticle,
    // `Session.fetch` cannot sign in to the tunnel's front, which the source tab's session may be pointed at: `net.request` answers it, with the tab's cookies as `Session.fetch` sent them.
    fetcher: (wc) => createRequestFetch({ net, session: wc.session, answer: answerRouteChallenge, credentials: 'include' }),
    publish: (topic, payload) => { services.internalPages.publish(topic, payload, ['reader']) },
    notify: (code) => { showToast(target, code) }
  }).catch((error: unknown) => { console.error('[reader] could not open reader view', error) })
}
