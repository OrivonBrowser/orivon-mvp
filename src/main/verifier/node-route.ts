// Which way the local nodes (IPFS, Swarm) leave: through the tunnel only when the whole browser is on it AND the person
// asked the nodes to follow ("Use tunnel to run network nodes"). Otherwise a node connects directly, whatever the tunnel
// does for the pages, which is what makes IPFS and Swarm pages load at a normal speed beside a tunnelled browser.
// The setting is supplied once the settings are read; until then the nodes run direct, the setting's default.

import { ownRequestsTunnelled } from '../route/own-requests.js'
import type { TunnelKind } from '../route/route-state.js'
import { systemProxyFor } from '../route/system-proxy.js'

let followTunnel: () => boolean = () => false
let nodesTunnel: () => TunnelKind = () => 'nym'

/** `nodesTunnel` is the tunnel the nodes run through when they do: the default one. */
export function configureNodeRoute (options: { followTunnel: () => boolean, nodesTunnel?: () => TunnelKind }): void {
  followTunnel = options.followTunnel
  nodesTunnel = options.nodesTunnel ?? (() => 'nym')
}

/** Whether the person asked the nodes to go through the tunnel when the browser does. */
export function nodesFollowTunnel (): boolean {
  return followTunnel()
}

/** Whether a node must run through the tunnel now. */
export function nodesRunThroughTunnel (): boolean {
  return ownRequestsTunnelled() && followTunnel()
}

/**
 * Whether the nodes may serve a website whose profile is the tunnel `tunnel`: not when they run outside the tunnel and the person
 * asked them to follow it, since the networks they ask would then see the address the tunnel hides for that website; and, when they
 * do run through a tunnel, only a website on that same tunnel, since one on the other would be read from the exit the nodes use.
 */
export function nodesMayServeTunnelSites (tunnel: TunnelKind): boolean {
  if (!followTunnel()) return true
  return ownRequestsTunnelled() && nodesTunnel() === tunnel
}

/**
 * Whether the Ethereum light client runs outside the tunnel: the person left "Use tunnel to run network nodes" off, and, while the
 * whole browser is on the tunnel, no proxy of the system's own applies (a proxy the person set must keep carrying what leaves, T20;
 * the light client then follows the tunnel, as it does with the setting on).
 */
export async function ethereumOutsideTunnel (tunnelled: boolean): Promise<boolean> {
  const outside = await lightClientOutside(tunnelled)
  console.error(`[verifier] routes: whole browser ${tunnelled ? 'on' : 'off'} the tunnel, light client ${tunnelled ? (outside ? 'outside it' : 'through it') : 'direct'}, nodes ${nodesRunThroughTunnel() ? 'through it' : 'direct'}`)
  return outside
}

async function lightClientOutside (tunnelled: boolean): Promise<boolean> {
  if (followTunnel()) return false
  if (!tunnelled) return true
  try {
    return (await systemProxyFor('https://example.com/')).trim() === 'DIRECT'
  } catch {
    return false
  }
}
