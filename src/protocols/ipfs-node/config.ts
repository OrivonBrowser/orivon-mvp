// The node's arguments, from the API port, the data directory and the
// person's routing choice. It keeps one SQLite database (with its journal)
// in the data directory, which is all it writes.

import { mkdir } from 'node:fs/promises'
import { GUEST_DATA_DIR } from '../local-node/kind.js'
import type { LocalNodeConfig } from '../local-node/protocol.js'
import { ROUTING_OPTION } from './protocol.js'
import type { RoutingMode } from './protocol.js'

export const PROGRAM_NAME = 'ipfs-node'
export const DATABASE_FILE = 'blocks.db'

/** The mode a config names; a start that names none, or one this build does not know, asks the network only: the choice that tells no service anything. */
export function routingModeOf (options: LocalNodeConfig['options']): RoutingMode {
  return options?.[ROUTING_OPTION] === 'auto' ? 'auto' : 'light-dht'
}

/** `argv[0]` is the program name. The node listens on loopback only, which `node-net.ts` enforces whatever the address says. */
export function nodeArguments (config: Pick<LocalNodeConfig, 'apiPort' | 'options'>): string[] {
  if (!Number.isInteger(config.apiPort) || config.apiPort < 1 || config.apiPort > 65_535) throw new RangeError('the API port is not a port')
  return [
    PROGRAM_NAME,
    '--addr', `127.0.0.1:${String(config.apiPort)}`,
    '--online',
    '--routing-mode', routingModeOf(config.options),
    '--db', `${GUEST_DATA_DIR}/${DATABASE_FILE}`,
    '--trace-filter', 'warn'
  ]
}

/** Makes the data directory. The node needs nothing else on disk before it starts. */
export async function prepareDataDir (dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
}
