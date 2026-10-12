// The Swarm node's files: where they are, and whether they are the ones this
// build pins. The glue is JavaScript that runs unsandboxed in a utility
// process, so what is read from disk is checked against the hashes compiled
// into the app (resources/swarm-node/swarm-node.json) before every start.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface PinnedFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface SwarmNodeManifest {
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
export async function verifyArtifact (directory: string, manifest: SwarmNodeManifest): Promise<ArtifactStatus> {
  for (const file of manifest.files) {
    const path = join(directory, file.name)
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return { ok: false, reason: `the Swarm node's file ${file.name} is missing from ${directory}` }
    }
    if (size !== file.bytes || await sha256Of(path) !== file.sha256) {
      return { ok: false, reason: `the Swarm node's file ${file.name} is not the one this build pins` }
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

/** The directory to look in: `ORIVON_SWARM_NODE_DIR` (still verified), else the package's resources, else the checkout's. */
export function artifactDirectory (where: WhereDeps): string {
  const named = where.env['ORIVON_SWARM_NODE_DIR']
  if (named !== undefined && named !== '') return named
  return where.packaged ? join(where.resourcesPath, 'swarm-node') : join(where.sourceRoot, 'resources', 'swarm-node')
}

export async function locateArtifact (where: WhereDeps, manifest: SwarmNodeManifest): Promise<ArtifactStatus> {
  const directory = artifactDirectory(where)
  const found = await verifyArtifact(directory, manifest)
  if (found.ok || where.env['ORIVON_SWARM_NODE_DIR'] !== undefined) return found
  return { ok: false, reason: `${found.reason}. The Swarm node is fetched when Orivon is installed (node scripts/fetch-swarm-node.mjs)` }
}
