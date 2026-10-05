import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeGrantRequest, describeInstallConsent } from '../grant-prompt-render.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// ADR-0032 and ADR-0055's consent copy for an app's media kinds, in its own file beside the secrets one.

const ORIGIN = 'https://app.example'

describe('describeCapabilityGrant -- media (ADR-0032, ADR-0055)', () => {
  it.each([
    ['media.camera', 'Use your camera'],
    ['media.microphone', 'Use your microphone'],
    ['media.screen', 'Ask to share your screen, a window or a tab; you choose each time']
  ] as const)('%s reads %j and is not a warning', (kind, message) => {
    const row = describeCapabilityGrant(kind, [])
    expect(row.message).toBe(message)
    expect(row.warning).toBe(false)
    expect(row.explanation).toBeUndefined()
  })

  it('still refuses to render clipboard.read: it has no app door', () => {
    expect(() => describeCapabilityGrant('clipboard.read', [])).toThrow(/not renderable/)
  })

  it('describeGrantRequest renders the one-capability prompt through the same rows', () => {
    const manifest = manifestWith({ media: { camera: true } })
    const content = describeGrantRequest(ORIGIN, manifest, 'media.camera', [])
    expect(content.message).toBe('Use your camera')
    expect(content.detail).toContain(ORIGIN)
  })

  it('install consent lists every declared media kind beside the others', () => {
    const manifest = manifestWith({ media: { camera: true, microphone: true, screen: true }, fs: {} })
    const content = describeInstallConsent(ORIGIN, manifest, ['fs', 'media.camera', 'media.microphone', 'media.screen'])
    expect(content.detail).toContain('- Use your camera')
    expect(content.detail).toContain('- Use your microphone')
    expect(content.detail).toContain('- Ask to share your screen, a window or a tab; you choose each time')
    expect(content.warning).toBe(false)
  })
})
