import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUEST_DATA_DIR } from '../../local-node/kind.js'
import { CONFIG_FILE, PASSWORD_FILE, nodeArguments, nodeYaml, prepareDataDir } from '../config.js'

let directory: string

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'swarm-node-config-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const PASSWORD = 'a'.repeat(48)

describe('nodeYaml', () => {
  it('is a read-only light node on mainnet, its API on loopback at the given port', () => {
    const lines = nodeYaml(24_242, PASSWORD).trim().split('\n')
    expect(lines).toEqual([
      'api-addr: 127.0.0.1:24242',
      'mainnet: true',
      'full-node: false',
      'swap-enable: false',
      'storage-incentives-enable: false',
      'skip-postage-snapshot: true',
      `data-dir: ${GUEST_DATA_DIR}`,
      `password: ${PASSWORD}`
    ])
  })

  it.each([0, -1, 65_536, 1.5, Number.NaN])('refuses the port %s', (port) => {
    expect(() => nodeYaml(port, PASSWORD)).toThrow(RangeError)
  })

  it.each(['', 'short', 'has space and: colons', 'ABCDEF0123456789ABCDEF', 'a\nmainnet: false'])('refuses the password %j, which no generated one is', (password) => {
    expect(() => nodeYaml(24_242, password)).toThrow(RangeError)
  })
})

describe('nodeArguments', () => {
  it('names the program, reads the config from the data directory, opens no control socket or disk cache, and keeps 250 peers', () => {
    expect(nodeArguments()).toEqual(['swarm-node', `--config=${GUEST_DATA_DIR}/${CONFIG_FILE}`, '--no-control-socket', '--no-disk-cache', '--target-peers=250'])
  })
})

describe('prepareDataDir', () => {
  it('makes the directory, a password and the YAML, readable by the owner only', async () => {
    const data = join(directory, 'nested', 'node')
    await prepareDataDir(data, 24_242)
    const password = (await readFile(join(data, PASSWORD_FILE), 'utf8')).trim()
    expect(password).toMatch(/^[0-9a-f]{48}$/)
    expect(await readFile(join(data, CONFIG_FILE), 'utf8')).toBe(nodeYaml(24_242, password))
    if (process.platform !== 'win32') {
      expect((await stat(join(data, PASSWORD_FILE))).mode & 0o077).toBe(0)
      expect((await stat(join(data, CONFIG_FILE))).mode & 0o077).toBe(0)
    }
  })

  it('keeps the password and rewrites the YAML for a new port', async () => {
    await prepareDataDir(directory, 24_242)
    const first = await readFile(join(directory, PASSWORD_FILE), 'utf8')
    await prepareDataDir(directory, 25_000)
    expect(await readFile(join(directory, PASSWORD_FILE), 'utf8')).toBe(first)
    expect(await readFile(join(directory, CONFIG_FILE), 'utf8')).toContain('127.0.0.1:25000')
  })

  it('makes a new password for a stored one that is not one', async () => {
    await prepareDataDir(directory, 24_242)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, PASSWORD_FILE), 'oops\n')
    await prepareDataDir(directory, 24_242)
    expect((await readFile(join(directory, PASSWORD_FILE), 'utf8')).trim()).toMatch(/^[0-9a-f]{48}$/)
  })
})
