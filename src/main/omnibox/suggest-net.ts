// The network half of engine suggestions, kept apart so the rest of the omnibox never imports Electron.
// `net.fetch` with `credentials: 'omit'` sends and stores no cookie; the request also carries no referrer.
import { net } from 'electron'
import type { FetchImpl } from './suggest-fetch.js'

export const fetchViaNet: FetchImpl = async (url, init) => await net.fetch(url, init)
