import { describe, expect, it } from 'vitest'
import { webRequestApi } from '../web-request.js'

/** What the entry defines on `chrome.webRequest`, rebuilt from its source text as the library runs it. */
function defined (): Record<string, unknown> {
  const rebuilt = new Function(`return (${webRequestApi.toString()})`)() as () => void
  let result: Record<string, unknown> = {}
  const crx = { define: (_ns: string, build: (b: unknown) => object) => { result = build({ onBeforeRequest: 'event' }) as Record<string, unknown> } }
  ;(globalThis as { __crx?: unknown }).__crx = crx
  try { rebuilt() } finally { delete (globalThis as { __crx?: unknown }).__crx }
  return result
}

describe('chrome.webRequest constants', () => {
  it('keeps the library\'s own events', () => {
    expect(defined().onBeforeRequest).toBe('event')
  })

  it('lists exactly the resource types Chrome names', () => {
    expect(Object.values(defined().ResourceType as Record<string, string>)).toEqual([
      'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
      'ping', 'csp_report', 'media', 'websocket', 'webbundle', 'other'
    ])
  })

  it('lists BLOCKING on the four enums Chrome gives it', () => {
    const api = defined()
    for (const name of ['OnBeforeRequestOptions', 'OnBeforeSendHeadersOptions', 'OnHeadersReceivedOptions', 'OnAuthRequiredOptions']) {
      expect((api[name] as Record<string, string>).BLOCKING).toBe('blocking')
    }
  })

  it('names the option values an extension passes as extraInfoSpec', () => {
    const api = defined()
    expect((api.OnHeadersReceivedOptions as Record<string, string>).EXTRA_HEADERS).toBe('extraHeaders')
    expect((api.OnAuthRequiredOptions as Record<string, string>).ASYNC_BLOCKING).toBe('asyncBlocking')
    expect((api.OnBeforeRequestOptions as Record<string, string>).REQUEST_BODY).toBe('requestBody')
  })

  it('answers handlerBehaviorChanged without throwing', async () => {
    await expect((defined().handlerBehaviorChanged as () => Promise<void>)()).resolves.toBeUndefined()
  })

  it('freezes the enums', () => {
    expect(Object.isFrozen(defined().ResourceType)).toBe(true)
  })
})
