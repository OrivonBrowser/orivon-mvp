// The node's YAML and arguments, from the API port and the data directory.
// The password only protects the node's key file on disk: it is generated
// once, kept beside it, and never leaves the machine.

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the component sees the data directory. */
export const GUEST_DATA_DIR = '/data'
export const CONFIG_FILE = 'swarm-node.yaml'
export const PASSWORD_FILE = 'swarm-node.password'

export const PROGRAM_NAME = 'swarm-node'

/** `argv[0]` is the program name; the node reads its config from the data directory and opens no control socket. */
export function nodeArguments (): string[] {
  return [PROGRAM_NAME, `--config=${GUEST_DATA_DIR}/${CONFIG_FILE}`, '--no-control-socket', '--no-disk-cache']
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
