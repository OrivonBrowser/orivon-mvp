// What an extension asks of one `chrome.webRequest.<event>.addListener` call:
// the `RequestFilter` and the `extraInfoSpec`, validated the way Chrome does,
// and the test that decides whether a listener's filter covers a request.

import { matchesHostPattern } from '../../../broker/policy/extension-host-patterns.js'

export const CHROME_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webbundle', 'other'
] as const
export type ChromeResourceType = (typeof CHROME_RESOURCE_TYPES)[number]

export type WebRequestEventName =
  | 'onBeforeRequest' | 'onBeforeSendHeaders' | 'onSendHeaders' | 'onHeadersReceived' | 'onAuthRequired'
  | 'onResponseStarted' | 'onBeforeRedirect' | 'onCompleted' | 'onErrorOccurred'

/** The `extraInfoSpec` values each event accepts. */
const ALLOWED_SPEC: Readonly<Record<WebRequestEventName, readonly string[]>> = {
  onBeforeRequest: ['blocking', 'requestBody', 'extraHeaders'],
  onBeforeSendHeaders: ['requestHeaders', 'blocking', 'extraHeaders'],
  onSendHeaders: ['requestHeaders', 'extraHeaders'],
  onHeadersReceived: ['blocking', 'responseHeaders', 'extraHeaders'],
  onAuthRequired: ['responseHeaders', 'blocking', 'asyncBlocking', 'extraHeaders'],
  onResponseStarted: ['responseHeaders', 'extraHeaders'],
  onBeforeRedirect: ['responseHeaders', 'extraHeaders'],
  onCompleted: ['responseHeaders', 'extraHeaders'],
  onErrorOccurred: ['extraHeaders']
}

/** The events whose listener may answer: Orivon dispatches these three and
 * waits for the reply. `onAuthRequired` accepts `blocking` but never fires. */
export const BLOCKING_EVENTS: ReadonlySet<WebRequestEventName> = new Set<WebRequestEventName>([
  'onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'
])

export function isWebRequestEvent (name: unknown): name is WebRequestEventName {
  return typeof name === 'string' && Object.hasOwn(ALLOWED_SPEC, name)
}

/** The `windowId` of Chrome's filter is accepted and not applied: every
 * request is matched on `urls`, `types` and `tabId` alone. */
export interface RequestFilter {
  readonly urls: readonly string[]
  readonly types?: readonly ChromeResourceType[]
  readonly tabId?: number
}

export interface ExtraInfoSpec {
  readonly blocking: boolean
  readonly asyncBlocking: boolean
  readonly requestHeaders: boolean
  readonly responseHeaders: boolean
  readonly extraHeaders: boolean
  readonly requestBody: boolean
}

export type Parsed<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: string }

const PATTERN_SHAPE = /^(\*|[a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)$/

function isMatchPattern (pattern: string): boolean {
  return pattern === '<all_urls>' || PATTERN_SHAPE.test(pattern)
}

/** Chrome's `RequestFilter`: `urls` (required, a non-empty list of match
 * patterns), then optional `types`, `tabId` and `windowId`. */
export function parseRequestFilter (raw: unknown): Parsed<RequestFilter> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'Invalid value for argument 2. Expected an object.' }
  const { urls, types, tabId, windowId } = raw as Record<string, unknown>
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, error: "Invalid value for argument 2. Property 'urls': Value must be a non-empty array." }
  for (const url of urls) {
    if (typeof url !== 'string' || !isMatchPattern(url)) return { ok: false, error: `Invalid value for argument 2. Property 'urls': Invalid url pattern '${String(url)}'` }
  }
  if (types !== undefined) {
    if (!Array.isArray(types)) return { ok: false, error: "Invalid value for argument 2. Property 'types': Expected array." }
    for (const type of types) {
      if (!(CHROME_RESOURCE_TYPES as readonly unknown[]).includes(type)) {
        return { ok: false, error: `Invalid value for argument 2. Property 'types': Value must be one of: [${CHROME_RESOURCE_TYPES.join(', ')}].` }
      }
    }
  }
  if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId))) return { ok: false, error: "Invalid value for argument 2. Property 'tabId': Expected integer." }
  if (windowId !== undefined && (typeof windowId !== 'number' || !Number.isInteger(windowId))) return { ok: false, error: "Invalid value for argument 2. Property 'windowId': Expected integer." }
  return {
    ok: true,
    value: {
      urls: urls as string[],
      ...(types === undefined ? {} : { types: types as ChromeResourceType[] }),
      ...(tabId === undefined ? {} : { tabId: tabId as number })
    }
  }
}

/** `extraInfoSpec`: absent, or a list of the strings `event` accepts. */
export function parseExtraInfoSpec (event: WebRequestEventName, raw: unknown): Parsed<ExtraInfoSpec> {
  const list: unknown = raw === undefined || raw === null ? [] : raw
  const allowed = ALLOWED_SPEC[event]
  if (!Array.isArray(list)) return { ok: false, error: 'Invalid value for argument 3. Expected array.' }
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== 'string' || !allowed.includes(entry)) {
      return { ok: false, error: `Invalid value for argument 3. Property '.${String(index)}': Value must be one of: [${allowed.join(', ')}].` }
    }
  }
  const has = (name: string): boolean => list.includes(name)
  return {
    ok: true,
    value: {
      blocking: has('blocking'),
      asyncBlocking: has('asyncBlocking'),
      requestHeaders: has('requestHeaders'),
      responseHeaders: has('responseHeaders'),
      extraHeaders: has('extraHeaders'),
      requestBody: has('requestBody')
    }
  }
}

/** `<all_urls>` in a webRequest filter also covers the WebSocket schemes,
 * which the shared match-pattern grammar leaves out of it. */
const ALL_URLS_FILTER_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ws:', 'wss:'])

function patternCovers (pattern: string, url: string): boolean {
  if (pattern !== '<all_urls>') return matchesHostPattern(pattern, url)
  try {
    return ALL_URLS_FILTER_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

export interface FilterableRequest {
  readonly url: string
  readonly type: string
  readonly tabId: number
}

export function filterMatches (filter: RequestFilter, request: FilterableRequest): boolean {
  if (filter.tabId !== undefined && filter.tabId !== request.tabId) return false
  if (filter.types !== undefined && !(filter.types as readonly string[]).includes(request.type)) return false
  return filter.urls.some((pattern) => patternCovers(pattern, request.url))
}
