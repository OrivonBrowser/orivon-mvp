// The node's arguments, from the API port, the data directory and the
// person's routing choice. It keeps one SQLite database (with its journal)
// in the data directory, which is all it writes.

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GUEST_DATA_DIR } from '../local-node/kind.js'
import type { LocalNodeConfig } from '../local-node/protocol.js'
import { ROUTING_OPTION } from './protocol.js'
import type { RoutingMode } from './protocol.js'

export const PROGRAM_NAME = 'ipfs-node'
export const DATABASE_FILE = 'blocks.db'
/** The directory SQLite takes beside the database as its lock. */
export const LOCK_DIRECTORY = `${DATABASE_FILE}.lock`

/**
 * The lookup services the node asks in `auto` mode, as the one comma list its `--delegated-router` takes, which it
 * races and fails over across. Two, so that one failing, or answered with an error page by a network that hijacks its
 * name, does not stop the other.
 */
export const DELEGATED_ROUTERS = ['https://delegated-ipfs.dev/routing/v1', 'https://cid.contact/routing/v1'] as const

/** The mode a config names; a start that names none, or one this build does not know, asks the network only: the choice that tells no service anything. */
export function routingModeOf (options: LocalNodeConfig['options']): RoutingMode {
  return options?.[ROUTING_OPTION] === 'auto' ? 'auto' : 'light-dht'
}

/** `argv[0]` is the program name. The node listens on loopback only, which `node-net.ts` enforces whatever the address says; the lookup services are named only when the person allows them. */
export function nodeArguments (config: Pick<LocalNodeConfig, 'apiPort' | 'options'>): string[] {
  if (!Number.isInteger(config.apiPort) || config.apiPort < 1 || config.apiPort > 65_535) throw new RangeError('the API port is not a port')
  const routing = routingModeOf(config.options)
  return [
    PROGRAM_NAME,
    '--addr', `127.0.0.1:${String(config.apiPort)}`,
    '--online',
    '--routing-mode', routing,
    ...(routing === 'auto' ? ['--delegated-router', DELEGATED_ROUTERS.join(',')] : []),
    '--db', `${GUEST_DATA_DIR}/${DATABASE_FILE}`,
    '--trace-filter', 'warn'
  ]
}

/**
 * Makes the data directory, and takes away a lock a process left behind. SQLite locks the database with a directory beside it,
 * and a node killed in the middle of a write (the tunnel setting changing under it, a quit) leaves that directory, after which
 * every start fails with "database is locked". One process at a time uses this directory (the supervisor starts the next only
 * after the last has exited), so a lock found here is stale.
 */
export async function prepareDataDir (dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await rm(join(dataDir, LOCK_DIRECTORY), { recursive: true, force: true })
}
