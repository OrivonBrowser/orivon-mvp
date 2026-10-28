// The node's YAML and arguments, from the API port and the data directory.
// The password only protects the node's key file on disk: it is generated
// once, kept beside it, and never leaves the machine.

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GUEST_DATA_DIR } from '../local-node/kind.js'

export const CONFIG_FILE = 'swarm-node.yaml'
export const PASSWORD_FILE = 'swarm-node.password'

export const PROGRAM_NAME = 'swarm-node'

/**
 * Peers the node keeps. Each peer serves a light node only a few chunks a second on credit, so the peer count bounds
 * how fast a file arrives: with the same read-ahead, 250 loaded the WebTorrent page in 24 to 26 s where the node's own
 * 100 took 30, and only with 250 did reading further ahead (`../swarm/joiner.ts`) help. It costs about 45 MB and a tenth
 * of a core more while the node sits idle. The node dials past this number to balance its neighbourhood, which can reach
 * `node-net.ts`'s 300 sockets: a dial past them is refused, and the node counts it as a failed one.
 */
export const TARGET_PEERS = 250

/** `argv[0]` is the program name; the node reads its config from the data directory and opens no control socket. */
export function nodeArguments (): string[] {
  return [PROGRAM_NAME, `--config=${GUEST_DATA_DIR}/${CONFIG_FILE}`, '--no-control-socket', '--no-disk-cache', `--target-peers=${String(TARGET_PEERS)}`]
}

/** A light node on mainnet: no postage snapshot, no swap, no storage incentives. */
export function nodeYaml (apiPort: number, password: string): string {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) throw new RangeError('the API port is not a port')
  if (!/^[0-9a-f]{16,}$/.test(password)) throw new RangeError('the password is not a generated one')
  return [
    `api-addr: 127.0.0.1:${String(apiPort)}`,
    'mainnet: true',
    'full-node: false',
    'swap-enable: false',
    'storage-incentives-enable: false',
    'skip-postage-snapshot: true',
    `data-dir: ${GUEST_DATA_DIR}`,
    `password: ${password}`,
    ''
  ].join('\n')
}

async function storedPassword (dataDir: string): Promise<string> {
  const file = join(dataDir, PASSWORD_FILE)
  try {
    const stored = (await readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{16,}$/.test(stored)) return stored
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const made = randomBytes(24).toString('hex')
  await writeFile(file, `${made}\n`, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return made
}

/** Makes the data directory, the password if it has none, and the YAML for this run's port. */
export async function prepareDataDir (dataDir: string, apiPort: number): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const password = await storedPassword(dataDir)
  await writeFile(join(dataDir, CONFIG_FILE), nodeYaml(apiPort, password), { mode: 0o600 })
}
