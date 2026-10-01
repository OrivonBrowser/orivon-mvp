// The connection a tab's address may show a mark for. It is computed on every push from the page's real URL,
// so a redirect or a back navigation can never leave a stale lock.
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { connectionOf } from '../../browsing/connection.js'
import { loadFailed } from '../load-failure.js'
import { appTabViews } from '../tab-partition.js'
import type { TabSignal } from '../tab-signals.js'

/** The host belongs to a protocol the verifier serves: a name, or an address's gateway endpoint. */
function servedByGateway (url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return BUILTIN_ADDRESSES.servedName(hostname) !== undefined || BUILTIN_ADDRESSES.schemeEndpoint(hostname) !== undefined
  } catch {
    return false
  }
}

export const connectionSignal: TabSignal = {
  name: 'connection',
  state: (record, wc) => {
    const url = wc?.getURL() ?? ''
    return {
      connection: connectionOf({
        url,
        displayUrl: BUILTIN_ADDRESSES.displayUrl(url),
        appTab: appTabViews.has(record.view),
        internal: record.internalPage != null,
        served: servedByGateway(url),
        failed: loadFailed(wc)
      })
    }
  }
}
