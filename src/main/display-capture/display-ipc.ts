// The messages a tab's preload sends the display-capture gate, read strictly: the sender must be the top frame of an
// ordinary or app tab, and a payload must have exactly the keys and types the preload sends. Anything else is dropped
// (a one-way message) or refused (a pick), never repaired.
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { DISPLAY_CAPTURE_CHANNEL, DISPLAY_CAPTURE_PICK_CHANNEL } from '../channels.js'
import type { DisplayGate, PickReply, PickRequest } from './display-gate.js'
import type { DisplayHints, FailureName } from './types.js'

const NONCE_MAX = 128
const SURFACES: readonly string[] = ['browser', 'window', 'monitor']
const INCLUDES: readonly string[] = ['include', 'exclude']
/** The names a failed call can carry: the preload reports any other as `AbortError`, so a page cannot make main read free text. */
const FAILURE_NAMES: readonly FailureName[] = ['NotAllowedError', 'AbortError', 'NotReadableError', 'NotFoundError']
const isFailureName = (value: unknown): value is FailureName => FAILURE_NAMES.includes(value as FailureName)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => key in value)
}

/** The hints a page's options carried: each one optional, and each from its own small set. */
export function readHints (raw: unknown): DisplayHints | undefined {
  if (!isRecord(raw)) return undefined
  const hints: { -readonly [K in keyof DisplayHints]: DisplayHints[K] } = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'displaySurface' && typeof value === 'string' && SURFACES.includes(value)) hints.displaySurface = value as 'browser' | 'window' | 'monitor'
    else if (key === 'preferCurrentTab' && typeof value === 'boolean') hints.preferCurrentTab = value
    else if ((key === 'selfBrowserSurface' || key === 'systemAudio' || key === 'monitorTypeSurfaces') && typeof value === 'string' && INCLUDES.includes(value)) hints[key] = value as 'include' | 'exclude'
    else return undefined
  }
  return hints
}

export function readPick (raw: unknown): PickRequest | undefined {
  if (!isRecord(raw) || !sameKeys(raw, ['type', 'audio', 'hints', 'activation'])) return undefined
  if (raw.type !== 'pick' || typeof raw.audio !== 'boolean' || typeof raw.activation !== 'boolean') return undefined
  const hints = readHints(raw.hints)
  return hints === undefined ? undefined : { audio: raw.audio, hints, activation: raw.activation }
}

export type DisplayReport =
  | { readonly type: 'arm', readonly nonce: string }
  | { readonly type: 'called', readonly nonce: string, readonly rejectedEarly: boolean }
  | { readonly type: 'tracks-ended', readonly nonce: string }
  | { readonly type: 'received', readonly nonce: string }
  | { readonly type: 'failed', readonly nonce: string, readonly name: FailureName }

export function readReport (raw: unknown): DisplayReport | undefined {
  if (!isRecord(raw) || typeof raw.nonce !== 'string' || raw.nonce.length === 0 || raw.nonce.length > NONCE_MAX) return undefined
  if ((raw.type === 'arm' || raw.type === 'tracks-ended' || raw.type === 'received') && sameKeys(raw, ['type', 'nonce'])) return { type: raw.type, nonce: raw.nonce }
  if (raw.type === 'called' && sameKeys(raw, ['type', 'nonce', 'rejectedEarly']) && typeof raw.rejectedEarly === 'boolean') return { type: 'called', nonce: raw.nonce, rejectedEarly: raw.rejectedEarly }
  if (raw.type === 'failed' && sameKeys(raw, ['type', 'nonce', 'name']) && isFailureName(raw.name)) return { type: 'failed', nonce: raw.nonce, name: raw.name }
  return undefined
}

/** The tab behind a message: the sender's webContents when the frame that sent it is that tab's top frame, and the tab is an ordinary or app tab. */
function senderTab (event: { sender: WebContents, senderFrame: unknown }, isTab: (contents: WebContents) => boolean): WebContents | undefined {
  const contents = event.sender
  if (contents.isDestroyed() || event.senderFrame !== contents.mainFrame || !isTab(contents)) return undefined
  return contents
}

export interface DisplayIpcDeps {
  ipc: {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) => void
    on: (channel: string, listener: (event: IpcMainEvent, raw: unknown) => void) => void
  }
  gate: DisplayGate
  isTab: (contents: WebContents) => boolean
}

export function registerDisplayIpc (deps: DisplayIpcDeps): void {
  deps.ipc.handle(DISPLAY_CAPTURE_PICK_CHANNEL, async (event, raw): Promise<PickReply> => {
    const contents = senderTab(event, deps.isTab)
    const request = readPick(raw)
    if (contents === undefined || request === undefined) return { type: 'refused', reason: 'denied' }
    return await deps.gate.pick(contents, request)
  })
  deps.ipc.on(DISPLAY_CAPTURE_CHANNEL, (event, raw) => {
    const contents = senderTab(event, deps.isTab)
    const report = readReport(raw)
    if (contents === undefined || report === undefined) return
    if (report.type === 'arm') deps.gate.arm(contents, report.nonce)
    else if (report.type === 'called') deps.gate.called(contents, report.nonce, report.rejectedEarly)
    else if (report.type === 'received') deps.gate.received(contents, report.nonce)
    else if (report.type === 'failed') deps.gate.failed(contents, report.nonce, report.name)
    else deps.gate.tracksEnded(contents, report.nonce)
  })
}
