// Unit-tests the handler ordering directly instead of through a real `.eth`
// fixture: an extension's `modifyHeaders`
// rule runs at `dnr-webrequest.ts`'s EXTENSION_ORDER, strictly before
// RUN_LAST -- so a RUN_LAST handler (the verifier's partition stamp,
// `../verifier/verifier-subsystem.ts`; the granted-origin CSP,
// `../install/granted-origin-csp.ts`) always applies AFTER an extension
// rule and so cannot have its header removed or altered by one, regardless
// of registration order.
import { describe, expect, it, vi } from 'vitest'
import { composeWebRequest } from '../web-request-compose.js'
import type { OrderedHandler } from '../web-request-compose.js'
import { RUN_LAST } from '../web-request-owner.js'

interface Details { readonly url: string }
interface Result { readonly cancel?: boolean, readonly requestHeaders: Record<string, string> }

const matchAll = (): boolean => true
const cancelled = (result: Result): boolean => result.cancel === true

/** An extension's modifyHeaders rule, at dnr-webrequest.ts's own order
 * (1000), trying to remove a header a RUN_LAST handler is about to set. */
const extensionRuleRemovesHeader: OrderedHandler<Details, Result> = {
  order: 1000,
  matches: matchAll,
  run: (_details, soFar) => {
    const requestHeaders = { ...soFar.requestHeaders }
    delete requestHeaders['x-orivon-partition']
    return { requestHeaders }
  },
}

/** The verifier's partition stamp / the granted-origin CSP's own shape:
 * registered at RUN_LAST, sets a header no extension rule may remove. */
const runLastSetsHeader: OrderedHandler<Details, Result> = {
  order: RUN_LAST,
  matches: matchAll,
  run: (_details, soFar) => ({ requestHeaders: { ...soFar.requestHeaders, 'x-orivon-partition': 'verified' } }),
}

describe('an extension rule cannot remove a RUN_LAST header, regardless of registration order', () => {
  it('RUN_LAST wins when registered after the extension handler', async () => {
    const onError = vi.fn()
    const result = await composeWebRequest(
      [extensionRuleRemovesHeader, runLastSetsHeader],
      { url: 'https://verified.eth.orivon/' },
      'https://verified.eth.orivon/',
      { requestHeaders: {} },
      cancelled,
      onError
    )
    expect(result.requestHeaders['x-orivon-partition']).toBe('verified')
  })

  it('RUN_LAST still wins when registered BEFORE the extension handler (order decides, not registration order)', async () => {
    const onError = vi.fn()
    const result = await composeWebRequest(
      [runLastSetsHeader, extensionRuleRemovesHeader],
      { url: 'https://verified.eth.orivon/' },
      'https://verified.eth.orivon/',
      { requestHeaders: {} },
      cancelled,
      onError
    )
    expect(result.requestHeaders['x-orivon-partition']).toBe('verified')
  })

  it('a header the extension rule adds instead of removing still cannot survive past RUN_LAST if RUN_LAST overwrites it', async () => {
    const onError = vi.fn()
    const extensionRuleForgesHeader: OrderedHandler<Details, Result> = {
      order: 1000,
      matches: matchAll,
      run: (_details, soFar) => ({ requestHeaders: { ...soFar.requestHeaders, 'x-orivon-partition': 'forged' } }),
    }
    const result = await composeWebRequest(
      [extensionRuleForgesHeader, runLastSetsHeader],
      { url: 'https://verified.eth.orivon/' },
      'https://verified.eth.orivon/',
      { requestHeaders: {} },
      cancelled,
      onError
    )
    expect(result.requestHeaders['x-orivon-partition']).toBe('verified')
  })
})
