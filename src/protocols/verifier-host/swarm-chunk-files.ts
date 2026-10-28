// The files in the verifier's directory that hold kept Swarm chunks. One database per salt: its name carries
// the first 16 hex of sha256(salt), so a replaced salt leaves files that nothing opens and anything can find.

import { createHash } from 'node:crypto'

const NAME = /^swarm-chunks-([0-9a-f]{16})\.db(?:-wal|-shm|-journal)?$/

/** The id a salt's database is named by: 64 bits of sha256(salt), which name nothing a person visited. */
export function swarmChunkId (saltHex: string): string {
  return createHash('sha256').update(Buffer.from(saltHex, 'hex')).digest('hex').slice(0, 16)
}

/** The database file of `saltHex`; its journal files add `-wal`, `-shm` and `-journal`. */
export function swarmChunkFile (saltHex: string): string {
  return `swarm-chunks-${swarmChunkId(saltHex)}.db`
}

/** Of `names`, the files that hold kept chunks (a database and its journal files), other than those of `exceptSalt`'s database. */
export function swarmChunkFilesIn (names: readonly string[], exceptSalt?: string): string[] {
  const kept = exceptSalt === undefined ? undefined : swarmChunkId(exceptSalt)
  return names.filter((name) => {
    const id = NAME.exec(name)?.[1]
    return id !== undefined && id !== kept
  })
}
