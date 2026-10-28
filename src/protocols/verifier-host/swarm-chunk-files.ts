// The files in the verifier's directory that hold kept Swarm chunks. One database per salt: its name carries
// the first 16 hex of sha256(salt), so a replaced salt leaves files that nothing opens and anything can find.

import { createHash } from 'node:crypto'

/** A database and the files SQLite keeps beside it. */
const SIDE_FILES = ['', '-wal', '-shm', '-journal'] as const
const NAME = new RegExp(`^swarm-chunks-([0-9a-f]{16})\\.db(?:${SIDE_FILES.slice(1).join('|')})?$`)

/** The id a salt's database is named by: 64 bits of sha256(salt), which name nothing a person visited. */
export function swarmChunkId (saltHex: string): string {
  return createHash('sha256').update(Buffer.from(saltHex, 'hex')).digest('hex').slice(0, 16)
}

/** The database file of `saltHex`. */
export function swarmChunkFile (saltHex: string): string {
  return `swarm-chunks-${swarmChunkId(saltHex)}.db`
}

/** The database file of `saltHex` and each file beside it. */
export function swarmChunkFileSet (saltHex: string): string[] {
  return SIDE_FILES.map((suffix) => `${swarmChunkFile(saltHex)}${suffix}`)
}

/** Of `names`, the files that hold kept chunks (a database and its side files), other than those of `exceptSalt`'s database. */
export function swarmChunkFilesIn (names: readonly string[], exceptSalt?: string): string[] {
  const kept = exceptSalt === undefined ? undefined : swarmChunkId(exceptSalt)
  return names.filter((name) => {
    const id = NAME.exec(name)?.[1]
    return id !== undefined && id !== kept
  })
}
