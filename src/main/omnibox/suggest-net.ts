// The network half of engine suggestions, kept apart so the rest of the omnibox never imports Electron.
// `net.fetch` with `credentials: 'omit'` sends and stores no cookie; the request also carries no referrer.
import { net } from 'electron'
import type { FetchImpl } from './suggest-fetch.js'
import { ownFetch } from '../route/own-requests.js'

// While the whole browser is on the tunnel the suggestions are asked through it (`ownFetch`), or not at all.
export const fetchViaNet: FetchImpl = ownFetch(async (url, init) => await net.fetch(url, init))
