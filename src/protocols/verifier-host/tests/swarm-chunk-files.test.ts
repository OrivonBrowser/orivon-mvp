import { describe, expect, it } from 'vitest'
import { swarmChunkFile, swarmChunkFilesIn, swarmChunkId } from '../swarm-chunk-files.js'

const SALT = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

describe('the names of kept Swarm chunk files', () => {
  it('names a database by 16 hex characters that follow from its salt alone', () => {
    expect(swarmChunkId(SALT)).toMatch(/^[0-9a-f]{16}$/)
    expect(swarmChunkId(SALT)).toBe(swarmChunkId(SALT))
    expect(swarmChunkId(SALT)).not.toBe(swarmChunkId(OTHER))
    expect(swarmChunkFile(SALT)).toBe(`swarm-chunks-${swarmChunkId(SALT)}.db`)
  })

  it('picks out a database and each of its journal files, and nothing else', () => {
    const own = swarmChunkFile(SALT)
    const names = [own, `${own}-wal`, `${own}-shm`, `${own}-journal`, 'swarm-chunks-xyz.db', 'swarm-chunks-0123456789abcdef.db.bak', 'checkpoint.json', 'blocks.db']
    expect(swarmChunkFilesIn(names)).toEqual([own, `${own}-wal`, `${own}-shm`, `${own}-journal`])
  })

  it('leaves out the files of the salt it is told to keep', () => {
    const own = swarmChunkFile(SALT)
    const old = swarmChunkFile(OTHER)
    expect(swarmChunkFilesIn([own, `${own}-wal`, old, `${old}-wal`], SALT)).toEqual([old, `${old}-wal`])
  })
})
