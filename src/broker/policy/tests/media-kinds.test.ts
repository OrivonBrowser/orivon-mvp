import { describe, expect, it } from 'vitest'
import { decideGrantRequest, isCapabilityKind } from '../request-grant.js'
import { patternSetFromCapabilities } from '../manifest-patterns.js'
import { widensAuthority } from '../update.js'
import type { Manifest } from '../../../contracts/index.js'

// ADR-0032 and ADR-0055: camera, microphone and screen are presence-only kinds, declared in `capabilities.media`.

const KINDS = ['media.camera', 'media.microphone', 'media.screen'] as const

const manifestWith = (media: Manifest['capabilities']['media']): Manifest => ({
  orivonApiVersion: 0, id: 'app.test.media', name: 'media', version: '1.0.0', entry: 'index.html',
  capabilities: media === undefined ? {} : { media }
})

describe('the media kinds', () => {
  it.each(KINDS)('%s is a capability kind', (kind) => {
    expect(isCapabilityKind(kind)).toBe(true)
  })

  it('clipboard.read is still not one: it has no app door', () => {
    expect(isCapabilityKind('clipboard.read')).toBe(false)
  })

  it('patternSetFromCapabilities sets each declared kind with no patterns and no other', () => {
    expect(patternSetFromCapabilities({ media: { camera: true, screen: true } })).toEqual({ 'media.camera': [], 'media.screen': [] })
    expect(patternSetFromCapabilities({})).toEqual({})
  })

  it.each(KINDS)('an update that newly declares %s widens authority', (kind) => {
    const declared = patternSetFromCapabilities(manifestWith({ camera: true, microphone: true, screen: true }).capabilities)
    expect(widensAuthority({}, { [kind]: declared[kind] ?? [] })).toBe(true)
  })

  it('an update that adds screen to a held camera widens; the same set does not', () => {
    const held = patternSetFromCapabilities({ media: { camera: true } })
    expect(widensAuthority(held, patternSetFromCapabilities({ media: { camera: true, screen: true } }))).toBe(true)
    expect(widensAuthority(held, patternSetFromCapabilities({ media: { camera: true } }))).toBe(false)
    expect(widensAuthority(patternSetFromCapabilities({ media: { camera: true, screen: true } }), held)).toBe(false)
  })

  it.each(KINDS)('app.requestGrant may ask for a declared %s and never an undeclared one', (kind) => {
    const declared = manifestWith({ camera: true, microphone: true, screen: true })
    expect(decideGrantRequest(declared, kind, undefined)).toEqual({ allowed: true, patterns: [] })
    expect(decideGrantRequest(manifestWith(undefined), kind, undefined)).toEqual({ allowed: false, patterns: [] })
  })

  it('a manifest declaring only the camera does not allow a request for the microphone', () => {
    expect(decideGrantRequest(manifestWith({ camera: true }), 'media.microphone', undefined)).toEqual({ allowed: false, patterns: [] })
  })
})
