// The network half of engine suggestions, kept apart so the rest of the omnibox never imports Electron.
// `net.fetch` with `credentials: 'omit'` sends and stores no cookie; the request also carries no referrer.
import { net } from 'electron'
import type { FetchImpl } from './suggest-fetch.js'
import { ownFetchForTab } from '../route/own-requests.js'
import { tunnelOfChoice } from '../route/tab-tunnel.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'

/**
 * While the whole browser is on the tunnel the suggestions are asked through it (`ownFetch`), or not at all. For the tab in front with a
 * tunnel choice they are asked through that tunnel's profile session, or not at all: what is typed there never leaves directly.
 */
export function suggestFetchFor (choice: TabTunnelChoice | undefined): FetchImpl {
  return ownFetchForTab(async (url, init) => await net.fetch(url, init), tunnelOfChoice(choice))
}
