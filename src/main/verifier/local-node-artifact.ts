// A local node's files: where they are, and whether they are the ones this
// build pins (the hashes compiled into the app from
// resources/<name>/<name>.json). This is the early, cheap refusal: a
// start that finds a wrong file ends before a process is forked. It is not
// what makes the run safe. The glue is JavaScript that runs unsandboxed in a
// utility process, which reads each file once and runs only the bytes it
// hashed (src/protocols/local-node/component.ts), so a file changed after
// this check is refused there.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { envName } from '../../protocols/local-node/protocol.js'
import type { NodeIdentity } from '../../protocols/local-node/kind.js'
import type { PinnedFile } from '../../protocols/local-node/protocol.js'

export type { PinnedFile }

export interface LocalNodeManifest {
  /** The IPFS directory the files are fetched from. */
  readonly cid: string
  /** The component's name: its glue is `<name>.js`. */
  readonly name: string
  readonly files: readonly PinnedFile[]
}

export type ArtifactStatus =
  | { readonly ok: true, readonly directory: string }
  | { readonly ok: false, readonly reason: string }

/** The manifest is not usable until the artifact is published and its CID is written in. */
export const UNPUBLISHED_CID = 'PLACEHOLDER-NOT-PUBLISHED'

async function sha256Of (path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Checks every pinned file in `directory`: present, the pinned size, the pinned hash. The reason names the first that is not. */
export async function verifyArtifact (directory: string, manifest: LocalNodeManifest, identity: NodeIdentity): Promise<ArtifactStatus> {
  for (const file of manifest.files) {
    const path = join(directory, file.name)
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return { ok: false, reason: `the ${identity.noun}'s file ${file.name} is missing from ${directory}` }
    }
    if (size !== file.bytes || await sha256Of(path) !== file.sha256) {
      return { ok: false, reason: `the ${identity.noun}'s file ${file.name} is not the one this build pins` }
    }
  }
  return { ok: true, directory }
}

export interface WhereDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly packaged: boolean
  /** `process.resourcesPath` of a package. */
  readonly resourcesPath: string
  /** The checkout, for a run from source. */
  readonly sourceRoot: string
}

/** The directory to look in: the one `ORIVON_<NAME>_DIR` names (still verified), else the package's resources, else the checkout's. */
export function artifactDirectory (where: WhereDeps, identity: NodeIdentity): string {
  const named = where.env[envName(identity.name, 'DIR')]
  if (named !== undefined && named !== '') return named
  return where.packaged ? join(where.resourcesPath, identity.name) : join(where.sourceRoot, 'resources', identity.name)
}

export async function locateArtifact (where: WhereDeps, manifest: LocalNodeManifest, identity: NodeIdentity): Promise<ArtifactStatus> {
  const directory = artifactDirectory(where, identity)
  const found = await verifyArtifact(directory, manifest, identity)
  if (found.ok || where.env[envName(identity.name, 'DIR')] !== undefined) return found
  const how = where.packaged ? `this build of Orivon was made without the ${identity.noun}` : 'run node scripts/fetch-local-nodes.mjs to fetch it'
  return { ok: false, reason: `${found.reason}; ${how}` }
}
