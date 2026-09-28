// Registers ADR-0039's embed host into the running app, and answers the
// one channel a shown page's preload asks on: which script its app set.

import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { EMBED_SCRIPT_CHANNEL } from '../channels.js'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { installEmbedHost } from './embed-host.js'
import type { EmbedHost } from './embed-host.js'

/** What `EMBED_SCRIPT_CHANNEL` answers: the script, or null for a guest with none to run. */
export type EmbedScriptReply = { readonly source: string } | null

/** What the reply needs from the sender -- structural, so a test double never needs the real `WebContents`. */
export interface EmbedScriptSender {
  readonly id: number
  getType(): string
}

/**
 * The script for the guest `sender` is, or null. Decided from the sender's
 * own identity alone: it must be a webview guest the host adopted, and its
 * app must still hold the grant (`scriptSync` answers undefined otherwise).
 * Nothing in the request is read.
 */
export function embedScriptReply (host: EmbedHost, broker: Broker, sender: EmbedScriptSender): EmbedScriptReply {
  if (sender.getType() !== 'webview') return null
  const appOrigin = host.ownerOf(sender.id)
  if (appOrigin === undefined) return null
  const source = broker.embed.scriptSync(appOrigin)
  return source === undefined ? null : { source }
}

export const embedSubsystem: Subsystem = {
  name: 'embed',
  afterReady: (ctx: SubsystemContext) => {
    if (ctx.broker === undefined) throw new Error('embed subsystem requires ctx.broker -- check its position in subsystems.ts')
    const broker = ctx.broker
    const host = installEmbedHost(broker)
    ipcMain.on(EMBED_SCRIPT_CHANNEL, (event) => {
      event.returnValue = embedScriptReply(host, broker, event.sender as WebContents)
    })
  }
}
