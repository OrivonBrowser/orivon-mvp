// capabilities.media (ADR-0032, ADR-0055): presence alone is the declaration, so a flag is `true` or absent, and
// an empty object declares nothing and is refused rather than read as a quiet no-op.

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'
import type { MediaCapability } from '../../../contracts/index.js'

function manifestWith (media: unknown): unknown {
  return {
    orivonApiVersion: 0,
    id: 'app.test',
    name: 'Test',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { media }
  }
}

function parsed (media: unknown): MediaCapability {
  const result = parseManifest(JSON.stringify(manifestWith(media)))
  if (!result.ok) throw new Error(`expected the manifest to parse, and it was rejected: ${result.reason}`)
  return result.manifest.capabilities.media ?? {}
}

function rejection (media: unknown): string {
  const result = parseManifest(JSON.stringify(manifestWith(media)))
  if (result.ok) throw new Error('expected the manifest to be rejected, and it parsed instead')
  return result.reason
}

describe('capabilities.media', () => {
  it.each(['camera', 'microphone', 'screen'])('accepts %s: true', (flag) => {
    expect(parsed({ [flag]: true })).toEqual({ [flag]: true })
  })

  it('accepts all three together and returns them unchanged', () => {
    expect(parsed({ camera: true, microphone: true, screen: true })).toEqual({ camera: true, microphone: true, screen: true })
  })

  it.each(['camera', 'microphone', 'screen'])('rejects %s: false', (flag) => {
    expect(rejection({ [flag]: false })).toContain(`media.${flag}`)
  })

  it.each([['a string', 'yes'], ['a number', 1], ['null', null], ['an object', {}], ['an array', [true]]])('rejects a flag that is %s', (_name, value) => {
    expect(rejection({ camera: value })).toContain('media.camera')
  })

  it('rejects an empty object: it declares nothing', () => {
    expect(rejection({})).toContain('media')
  })

  it('rejects an unrecognised field, naming it', () => {
    expect(rejection({ camera: true, speakers: true })).toContain('speakers')
  })

  it('rejects a media value that is not an object', () => {
    expect(rejection(true)).toContain('media must be an object')
    expect(rejection([])).toContain('media must be an object')
  })

  it('does not accept the clipboard flag inside media', () => {
    expect(rejection({ read: true })).toContain('read')
  })
})
