// The names Helios is given for its two servers, and the words it says about them back. Helios reaches the network through the
// process's one global fetch, so each client is told names that resolve nowhere (`.invalid`) and a dispatcher maps them to the
// real servers (light-client.ts). A name Helios never holds the real address of can not quote it, in an error or anywhere.

import type { LightClientConfig, TunnelRoute } from '../protocol.js'
import { displayEndpoint, maskText } from './endpoint-mask.js'

/** What a client gives Helios for its two servers: one lane per route, `direct` for the shared client and a tunnel's name for that tunnel's. */
export const laneNames = (route: 'direct' | TunnelRoute): { readonly execution: string, readonly consensus: string } => ({
  execution: `https://${route}-execution.orivon.invalid`,
  consensus: `https://${route}-consensus.orivon.invalid`
})

/**
 * `text` as it may be shown or logged: each lane name read as the server it stands for (the execution lane as the first of `asked`, the
 * servers still in use, which is all of the configured ones until a start drops one), masked, and no part of a configured address left in it.
 */
export function publicText (text: string, names: { readonly execution: string, readonly consensus: string }, config: Pick<LightClientConfig, 'executionRpcs' | 'consensusRpc'>, asked: readonly string[] = config.executionRpcs): string {
  const primary = asked[0]
  let out = text
  if (primary !== undefined) out = out.split(names.execution).join(displayEndpoint(primary))
  out = out.split(names.consensus).join(displayEndpoint(config.consensusRpc))
  return maskText(out, [...config.executionRpcs, config.consensusRpc])
}
