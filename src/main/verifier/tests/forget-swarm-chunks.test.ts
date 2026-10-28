import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { swarmChunkFile } from '../../../protocols/verifier-host/swarm-chunk-files.js'
import { removeSwarmChunkFiles } from '../forget-swarm-chunks.js'

const SALT = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-forget-swarm-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const touch = (name: string): void => { writeFileSync(join(dir, name), 'x') }

describe('forgetting the Swarm chunks the host keeps', () => {
  it('deletes every database and journal file of kept chunks, and nothing else', async () => {
    const old = swarmChunkFile(OTHER)
    for (const name of [old, `${old}-wal`, `${old}-shm`, `${old}-journal`, swarmChunkFile(SALT), 'checkpoint.json', 'ipfs-node-partition-salt.json']) touch(name)
    await removeSwarmChunkFiles(dir)
    expect(readdirSync(dir).sort()).toEqual(['checkpoint.json', 'ipfs-node-partition-salt.json'])
  })

  it('keeps the files of the salt it is told to keep', async () => {
    touch(swarmChunkFile(SALT))
    touch(`${swarmChunkFile(SALT)}-wal`)
    touch(swarmChunkFile(OTHER))
    await removeSwarmChunkFiles(dir, SALT)
    expect(readdirSync(dir).sort()).toEqual([swarmChunkFile(SALT), `${swarmChunkFile(SALT)}-wal`].sort())
  })

  it('finds nothing to do in a directory that does not exist', async () => {
    await expect(removeSwarmChunkFiles(join(dir, 'missing'))).resolves.toBeUndefined()
  })

  it('tries every file before it reports one it could not delete', async () => {
    const stuck = swarmChunkFile(OTHER)
    mkdirSync(join(dir, stuck))
    writeFileSync(join(dir, stuck, 'inside'), 'x')
    touch(`${stuck}-wal`)
    touch(swarmChunkFile(SALT))
    await expect(removeSwarmChunkFiles(dir)).rejects.toBeDefined()
    expect(existsSync(join(dir, `${stuck}-wal`))).toBe(false)
    expect(existsSync(join(dir, swarmChunkFile(SALT)))).toBe(false)
  })
})
