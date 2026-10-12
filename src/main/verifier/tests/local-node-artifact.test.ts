import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import shipped from '../../../../resources/swarm-node/swarm-node.json'
import { SWARM_NODE_IDENTITY as KIND } from '../../../protocols/swarm-node/protocol.js'
import { artifactDirectory, locateArtifact, verifyArtifact } from '../local-node-artifact.js'
import type { LocalNodeManifest } from '../local-node-artifact.js'

const GLUE = Buffer.from('glue bytes')
const CORE = Buffer.from('core bytes')
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const MANIFEST: LocalNodeManifest = {
  cid: 'bafyexample',
  name: 'swarm-node',
  files: [{ name: 'swarm-node.js', bytes: GLUE.length, sha256: sha(GLUE) }, { name: 'swarm-node.core.wasm', bytes: CORE.length, sha256: sha(CORE) }]
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swarm-node-artifact-'))
  await writeFile(join(dir, 'swarm-node.js'), GLUE)
  await writeFile(join(dir, 'swarm-node.core.wasm'), CORE)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('verifyArtifact', () => {
  it('accepts a directory holding every pinned file', async () => {
    expect(await verifyArtifact(dir, MANIFEST, KIND)).toEqual({ ok: true, directory: dir })
  })

  it('names a file that is missing', async () => {
    await rm(join(dir, 'swarm-node.core.wasm'))
    expect(await verifyArtifact(dir, MANIFEST, KIND)).toEqual({ ok: false, reason: expect.stringContaining('swarm-node.core.wasm is missing') as string })
  })

  it('names a file with the right size and other bytes, and one of another size', async () => {
    await writeFile(join(dir, 'swarm-node.js'), Buffer.from('GLUE BYTES'))
    expect(await verifyArtifact(dir, MANIFEST, KIND)).toEqual({ ok: false, reason: expect.stringContaining('swarm-node.js is not the one this build pins') as string })
    await writeFile(join(dir, 'swarm-node.js'), GLUE)
    await writeFile(join(dir, 'swarm-node.core.wasm'), Buffer.concat([CORE, Buffer.from('!')]))
    expect(await verifyArtifact(dir, MANIFEST, KIND)).toEqual({ ok: false, reason: expect.stringContaining('swarm-node.core.wasm is not the one') as string })
  })
})

describe('artifactDirectory', () => {
  const where = { env: {}, packaged: false, resourcesPath: '/opt/orivon/resources', sourceRoot: '/home/me/orivon' }

  it('is the checkout\'s resources from source, the package\'s resources when packaged', () => {
    expect(artifactDirectory(where, KIND)).toBe(join('/home/me/orivon', 'resources', 'swarm-node'))
    expect(artifactDirectory({ ...where, packaged: true }, KIND)).toBe(join('/opt/orivon/resources', 'swarm-node'))
  })

  it('is the directory ORIVON_SWARM_NODE_DIR names, in either', () => {
    expect(artifactDirectory({ ...where, env: { ORIVON_SWARM_NODE_DIR: '/elsewhere' } }, KIND)).toBe('/elsewhere')
    expect(artifactDirectory({ ...where, packaged: true, env: { ORIVON_SWARM_NODE_DIR: '/elsewhere' } }, KIND)).toBe('/elsewhere')
    expect(artifactDirectory({ ...where, env: { ORIVON_SWARM_NODE_DIR: '' } }, KIND)).toBe(join('/home/me/orivon', 'resources', 'swarm-node'))
  })
})

describe('locateArtifact', () => {
  it('verifies the directory the variable names, and says how to fetch the files when the ordinary one lacks them', async () => {
    const where = { env: { ORIVON_SWARM_NODE_DIR: dir }, packaged: false, resourcesPath: '/none', sourceRoot: '/none' }
    expect(await locateArtifact(where, MANIFEST, KIND)).toEqual({ ok: true, directory: dir })
    const missing = await locateArtifact({ ...where, env: {} }, MANIFEST, KIND)
    expect(missing).toEqual({ ok: false, reason: expect.stringContaining('fetch-local-nodes.mjs') as string })
    const packaged = await locateArtifact({ ...where, env: {}, packaged: true, resourcesPath: dir.replace(/\/[^/]*$/, '/no-such-resources') }, MANIFEST, KIND)
    expect(packaged).toEqual({ ok: false, reason: expect.stringContaining('made without the Swarm node') as string })
  })
})

describe('the manifest this build pins', () => {
  it('names a component with its glue and every file as a size and a sha256', () => {
    expect(shipped.name).toBe('swarm-node')
    expect(shipped.files.map((file) => file.name)).toContain('swarm-node.js')
    expect(shipped.files.map((file) => file.name)).toContain('LICENSE')
    for (const file of shipped.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.bytes).toBeGreaterThan(0)
      expect(file.name).toMatch(/^[\w.-]+$/)
    }
  })

  it('is read from a file the build compiles in', async () => {
    expect(JSON.parse(await readFile(join(process.cwd(), 'resources/swarm-node/swarm-node.json'), 'utf8'))).toEqual(shipped)
  })
})
