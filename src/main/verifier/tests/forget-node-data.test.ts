import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { swarmChunkFile } from '../../../protocols/verifier-host/swarm-chunk-files.js'
import { HOST_EXIT_WAIT_MS, forgetNodeData, removeSwarmChunkFiles } from '../forget-node-data.js'
import type { ForgetDeps } from '../forget-node-data.js'

const SALT = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const NEW_SALT = 'ef'.repeat(32)

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-forget-node-')) })
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const touch = (name: string): void => { writeFileSync(join(dir, name), 'x') }
const swarmFiles = (): string[] => readdirSync(dir).filter((name) => name.startsWith('swarm-chunks-')).sort()

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

describe('forgetting what the nodes and the host kept', () => {
  function deps (events: string[], hostGone: () => Promise<void> = async () => { events.push('host exited') }, currentSalt: () => string = () => NEW_SALT): ForgetDeps {
    return {
      forgetIpfsNode: async () => { events.push('ipfs node forgotten') },
      replaceSalt: () => { events.push('salt replaced') },
      currentSalt,
      sleepHost: () => { events.push('host asleep') },
      hostGone,
      directory: () => dir
    }
  }

  it('replaces the salt, puts the host to sleep, waits for it to exit and only then deletes the chunk files', async () => {
    const old = swarmChunkFile(SALT)
    touch(old)
    touch(`${old}-wal`)
    touch('checkpoint.json')
    const events: string[] = []
    let exit!: () => void
    const exited = new Promise<void>((resolve) => { exit = resolve })
    const done = forgetNodeData(deps(events, async () => { events.push('waiting'); await exited; events.push('host exited') }))
    await vi.waitFor(() => { expect(events).toEqual(['ipfs node forgotten', 'salt replaced', 'host asleep', 'waiting']) })
    expect(swarmFiles()).toHaveLength(2)
    exit()
    await done
    expect(events.at(-1)).toBe('host exited')
    expect(swarmFiles()).toEqual([])
    expect(existsSync(join(dir, 'checkpoint.json'))).toBe(true)
  })

  it('does not wait for ever on a host that does not exit, and still deletes', async () => {
    vi.useFakeTimers()
    touch(swarmChunkFile(SALT))
    const done = forgetNodeData(deps([], async () => await new Promise<void>(() => {})))
    await vi.advanceTimersByTimeAsync(HOST_EXIT_WAIT_MS - 1)
    expect(swarmFiles()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(swarmFiles()).toEqual([])
  })

  it('leaves the file of the new salt, which a host started meanwhile may already hold open', async () => {
    touch(swarmChunkFile(SALT))
    touch(swarmChunkFile(NEW_SALT))
    await forgetNodeData(deps([]))
    expect(swarmFiles()).toEqual([swarmChunkFile(NEW_SALT)])
  })

  it('spares the salt in force when the files go, not the one it set: a second clear may have replaced it while the host was leaving', async () => {
    const SECOND = '12'.repeat(32)
    touch(swarmChunkFile(SALT))
    touch(swarmChunkFile(NEW_SALT))
    touch(swarmChunkFile(SECOND))
    let salt = NEW_SALT
    await forgetNodeData(deps([], async () => { salt = SECOND }, () => salt))
    expect(swarmFiles()).toEqual([swarmChunkFile(SECOND)])
  })

  it('still replaces the salt and deletes the chunk files when the IPFS node could not be forgotten, and then reports it', async () => {
    touch(swarmChunkFile(SALT))
    const events: string[] = []
    const failing = { ...deps(events), forgetIpfsNode: async () => { throw new Error('locked') } }
    await expect(forgetNodeData(failing)).rejects.toThrow('locked')
    expect(events).toContain('salt replaced')
    expect(swarmFiles()).toEqual([])
  })
})
