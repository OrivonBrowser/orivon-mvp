// Chrome-shaped `webRequest` details built from the details Electron gives
// the session's listeners. Electron's own objects are described structurally
// so this file imports nothing from `electron`.

import { mapElectronResourceType, type ElectronResourceType } from '../dnr/resource-types.js'
import { frameIdOf, initiatorOf, parentFrameIdOf, safeFrame, type FrameLike } from '../request-frames.js'
import type { ExtraInfoSpec, WebRequestEventName } from './filter.js'

export interface ElectronUploadData {
  readonly bytes?: Uint8Array
  readonly file?: string
  readonly blobUUID?: string
}

/** The fields of Electron's `On<Event>ListenerDetails` this file reads; an
 * event fills only the ones it has. */
export interface ElectronRequestDetails {
  readonly id: number
  readonly url: string
  readonly method: string
  readonly resourceType: ElectronResourceType
  readonly webContentsId?: number | undefined
  readonly frame?: FrameLike | null | undefined
  readonly timestamp: number
  readonly uploadData?: readonly ElectronUploadData[] | undefined
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined
  readonly responseHeaders?: Readonly<Record<string, readonly string[]>> | undefined
  readonly statusCode?: number | undefined
  readonly statusLine?: string | undefined
  readonly fromCache?: boolean | undefined
  readonly ip?: string | undefined
  readonly redirectURL?: string | undefined
  readonly error?: string | undefined
}

export interface HttpHeader {
  readonly name: string
  readonly value: string
}

/** The shape an extension reads. Optional fields are left out when absent. */
export interface WebRequestDetails {
  readonly requestId: string
  readonly url: string
  readonly method: string
  readonly type: string
  readonly tabId: number
  readonly frameId: number
  readonly parentFrameId: number
  readonly frameType: 'outermost_frame' | 'sub_frame'
  readonly documentLifecycle: 'active'
  readonly timeStamp: number
  readonly initiator?: string
  readonly statusCode?: number
  readonly statusLine?: string
  readonly fromCache?: boolean
  readonly ip?: string
  readonly redirectUrl?: string
  readonly error?: string
  readonly requestHeaders?: HttpHeader[]
  readonly responseHeaders?: HttpHeader[]
  readonly requestBody?: { readonly raw: Array<{ readonly bytes: ArrayBuffer }> }
}

export function headersToList (headers: Readonly<Record<string, string>> | undefined): HttpHeader[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
}

/** One entry per value: Chrome lists a repeated header as repeated entries. */
export function responseHeadersToList (headers: Readonly<Record<string, readonly string[]>> | undefined): HttpHeader[] {
  return Object.entries(headers ?? {}).flatMap(([name, values]) => values.map((value) => ({ name, value })))
}

function requestBodyOf (upload: readonly ElectronUploadData[] | undefined): WebRequestDetails['requestBody'] | undefined {
  const raw: Array<{ bytes: ArrayBuffer }> = []
  for (const part of upload ?? []) {
    if (part.bytes === undefined) continue
    raw.push({ bytes: part.bytes.buffer.slice(part.bytes.byteOffset, part.bytes.byteOffset + part.bytes.byteLength) as ArrayBuffer })
  }
  return raw.length === 0 ? undefined : { raw }
}

/** What identifies the request, plus what `event` reports about it. A tab id only
 * for a `webContentsId` that `isTab` knows; every other page reports -1. */
export function baseDetails (event: WebRequestEventName, raw: ElectronRequestDetails, isTab: (webContentsId: number) => boolean): WebRequestDetails {
  const type = mapElectronResourceType(raw.resourceType)
  const frame = safeFrame(raw)
  const parent = frame?.parent ?? null
  // A navigation is initiated by the document that embeds it: the frame's parent for a sub_frame, no one for the top frame.
  const initiator = type === 'main_frame'
    ? undefined
    : type === 'sub_frame' ? initiatorOf(parent) : initiatorOf(frame)
  const parentFrameId = frame === null ? undefined : parentFrameIdOf(frame)
  return {
    requestId: String(raw.id),
    url: raw.url,
    method: raw.method,
    type,
    tabId: raw.webContentsId !== undefined && isTab(raw.webContentsId) ? raw.webContentsId : -1,
    frameId: frame === null ? 0 : frameIdOf(frame),
    parentFrameId: parentFrameId ?? -1,
    frameType: parent === null ? 'outermost_frame' : 'sub_frame',
    documentLifecycle: 'active',
    timeStamp: raw.timestamp,
    ...(initiator === undefined ? {} : { initiator }),
    ...(raw.statusCode === undefined ? {} : { statusCode: raw.statusCode }),
    ...(raw.statusLine === undefined ? {} : { statusLine: raw.statusLine }),
    ...(raw.fromCache === undefined ? {} : { fromCache: raw.fromCache }),
    ...(raw.ip === undefined ? {} : { ip: raw.ip }),
    ...(event !== 'onBeforeRedirect' || raw.redirectURL === undefined ? {} : { redirectUrl: raw.redirectURL }),
    ...(event !== 'onErrorOccurred' || raw.error === undefined ? {} : { error: raw.error })
  }
}

/** The fields of a request that an `extraInfoSpec` adds. A caller may pass
 * the headers as an earlier handler left them instead of Electron's own. */
export type RequestPayload = Pick<ElectronRequestDetails, 'uploadData' | 'requestHeaders' | 'responseHeaders'>

/** `base` plus what one listener asked for in its `extraInfoSpec`. */
export function detailsFor (event: WebRequestEventName, base: WebRequestDetails, raw: RequestPayload, spec: ExtraInfoSpec): WebRequestDetails {
  const requestBody = event === 'onBeforeRequest' && spec.requestBody ? requestBodyOf(raw.uploadData) : undefined
  const sendsRequestHeaders = (event === 'onBeforeSendHeaders' || event === 'onSendHeaders') && spec.requestHeaders
  const reportsResponseHeaders = event !== 'onBeforeRequest' && event !== 'onBeforeSendHeaders' && event !== 'onSendHeaders' && event !== 'onErrorOccurred' && spec.responseHeaders
  return {
    ...base,
    ...(requestBody === undefined ? {} : { requestBody }),
    ...(sendsRequestHeaders ? { requestHeaders: headersToList(raw.requestHeaders) } : {}),
    ...(reportsResponseHeaders && raw.responseHeaders !== undefined ? { responseHeaders: responseHeadersToList(raw.responseHeaders) } : {})
  }
}
