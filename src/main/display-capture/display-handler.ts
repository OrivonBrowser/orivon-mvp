// What `setDisplayMediaRequestHandler` answers for a share the person picked: the source in the ticket the preload's
// call was granted against, as Electron's streams, and nothing for a request that holds no ticket. Starts the share in
// the registry once Electron has the answer.
import type { WebContents, WebFrameMain } from 'electron'
import type { DisplayMediaHandler } from '../sessions/display-media-handler.js'
import type { DisplayTickets } from './display-tickets.js'
import { frameKeyOf } from './frame-key.js'
import type { ShareHost } from './share-registry.js'
import type { DisplayChoice } from './types.js'

export interface DisplayHandlerDeps {
  tickets: Pick<DisplayTickets<DisplayChoice>, 'consumeDisplay'>
  /** The tab a frame belongs to. */
  contentsOf: (frame: WebFrameMain) => WebContents | undefined
  shares: Pick<ShareHost, 'start'>
  platform: NodeJS.Platform
}

type Streams = Parameters<Parameters<DisplayMediaHandler>[1]>[0]

/** The streams for a choice, and whether the page gets audio with them; undefined when the choice cannot be served now. */
export function streamsFor (choice: DisplayChoice, audioRequested: boolean, platform: NodeJS.Platform): { streams: Streams, audio: boolean } | undefined {
  if (choice.kind === 'tab') {
    if (choice.tab.isDestroyed()) return undefined
    const frame = choice.tab.mainFrame
    const audio = choice.audio && audioRequested
    return { streams: audio ? { video: frame, audio: frame } : { video: frame }, audio }
  }
  const audio = choice.systemAudio && audioRequested && platform === 'win32'
  const video = { id: choice.source.id, name: choice.source.name }
  return { streams: audio ? { video, audio: 'loopback' } : { video }, audio }
}

export function createDisplayHandler (deps: DisplayHandlerDeps): DisplayMediaHandler {
  return (request, callback) => {
    const frame = request.frame
    const contents = frame === null ? undefined : deps.contentsOf(frame)
    // Only a tab's top frame ever holds a ticket.
    if (frame === null || contents === undefined || contents.isDestroyed() || frame !== contents.mainFrame) { callback({}); return }
    const key = frameKeyOf(contents, frame)
    const taken = key === undefined ? undefined : deps.tickets.consumeDisplay(key)
    const served = taken === undefined ? undefined : streamsFor(taken.choice, request.audioRequested, deps.platform)
    if (taken === undefined || served === undefined) { callback({}); return }
    callback(served.streams)
    deps.shares.start({ requester: contents, origin: request.securityOrigin, choice: taken.choice, audio: served.audio, nonce: taken.nonce })
  }
}
