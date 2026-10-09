import { describe, expect, it } from 'vitest'
import { parsePending, pendingRecord } from '../pending-consent.js'
import { manifestJson, ORIGIN, utf8 } from './test-helpers.js'
import { parseManifest } from '../manifest/manifest.js'
import type { FirstManifestApp } from '../first-visit.js'

// What is read back off disk about a consent is untrusted: anything this version did not write is no consent.

function readOf (): FirstManifestApp {
  const bytes = utf8(manifestJson({ assets: ['app.js'] }))
  const parsed = parseManifest(new TextDecoder().decode(bytes))
  if (!parsed.ok) throw new Error(parsed.reason)
  return { kind: 'app', canonicalOrigin: ORIGIN, manifest: parsed.manifest, bytes, content: { cid: 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi', via: 'ipns-key', pointersVerified: true } }
}

const tree = { bundleHash: `sha256:${'a'.repeat(64)}`, leaves: [{ path: '/index.html', leaf: `sha256:${'b'.repeat(64)}` }] }

describe('pending consent records', () => {
  it('round-trips through JSON as disk does', () => {
    const read = readOf()
    const back = parsePending(JSON.parse(JSON.stringify(pendingRecord(read, tree, 5))))
    expect(back?.read.manifest).toEqual(read.manifest)
    expect(back?.read.content).toEqual(read.content)
    expect(Array.from(back?.read.bytes ?? [])).toEqual(Array.from(read.bytes))
    expect(back?.declaration).toEqual(tree)
  })

  it('keeps the exact bytes of a manifest that is not valid UTF-8 through, so its leaf is the same', () => {
    const read = { ...readOf(), bytes: new Uint8Array([...utf8(manifestJson({ description: 'x' })).slice(0, -1), 0x20, 0xff, 0x7d]) }
    const back = parsePending(JSON.parse(JSON.stringify(pendingRecord(read, undefined, 5))))
    if (back !== undefined) expect(Array.from(back.read.bytes)).toEqual(Array.from(read.bytes))
  })

  it('refuses a record that names another origin than a valid one, a manifest that is not one, or a root or tree that is malformed', () => {
    const good = JSON.parse(JSON.stringify(pendingRecord(readOf(), tree, 5))) as Record<string, unknown>
    expect(parsePending(good)).toBeDefined()
    for (const broken of [
      { ...good, origin: 'not an origin' },
      { ...good, origin: 'https://app.example.com/path' },
      { ...good, manifestBytes: Buffer.from('{"nope":1}').toString('base64') },
      { ...good, manifestBytes: 7 },
      { ...good, content: { cid: 'x', via: 'ipfs', pointersVerified: true } },
      { ...good, declaration: { bundleHash: 'nope', leaves: {} } },
      null,
      [],
      'text'
    ]) expect(parsePending(broken)).toBeUndefined()
  })
})
