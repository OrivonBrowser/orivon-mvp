import { describe, expect, it } from 'vitest'
import { describeCapabilityChoice } from '../grant-prompt-choice.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'
import { patternSetFromCapabilities } from '../../../broker/policy/manifest-patterns.js'
import type { CapabilityKind } from '../../../contracts/index.js'

// Part 2 of A138 (docs/open-questions.md): one screen in the per-capability
// choice sequence -- decides exactly ONE capability while the rest of the
// declared set stays visible, the property neither a plain sequence of
// independent native dialogs nor a single checkbox-list dialog (unsupported
// by dialog.showMessageBox) can offer alone. Reuses describeCapabilityGrant's
// own wording verbatim (grant-prompt-render.ts) -- this suite never invents
// its own copy for what a capability means, only for how the SEQUENCE reads.

const ORIGIN = 'https://app.example'

describe('describeCapabilityChoice', () => {
  it('renders the CURRENT capability\'s own row as message/warning, matching describeCapabilityGrant verbatim', () => {
    const manifest = manifestWith({ net: { https: { connect: ['youtube.com:443'] } }, fs: { quotaBytes: 1024 } })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['https.connect', 'fs']

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 0, new Map())

    expect(content.message).toBe('Connect to youtube.com')
    expect(content.warning).toBe(false)
  })

  it('marks the current item, in a request of several, distinctly from the others', () => {
    const manifest = manifestWith({ net: { https: { connect: ['youtube.com:443'] } }, fs: { quotaBytes: 1024 } })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['https.connect', 'fs']

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 1, new Map())

    expect(content.message).toBe('Store files in a private folder for this app on this device')
    expect(content.detail).toContain('> Store files in a private folder for this app on this device')
    // The other, not-current, row is still listed as context -- the whole
    // point of this screen over a plain independent dialog.
    expect(content.detail).toContain('Connect to youtube.com')
  })

  it('shows the progress count (i of N)', () => {
    const manifest = manifestWith({ net: { https: { connect: ['a.example:443'] } }, fs: {}, id: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['https.connect', 'fs', 'id']

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 1, new Map())

    expect(content.detail).toContain('2 of 3')
  })

  it('marks an earlier item this SAME sequence already allowed', () => {
    const manifest = manifestWith({ net: { https: { connect: ['a.example:443'] } }, fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['https.connect', 'fs']
    const decided = new Map<CapabilityKind, boolean>([['https.connect', true]])

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 1, decided)

    expect(content.detail).toContain('[Allowed] Connect to a.example')
  })

  it('marks an earlier item this SAME sequence already denied', () => {
    const manifest = manifestWith({ net: { https: { connect: ['a.example:443'] } }, fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['https.connect', 'fs']
    const decided = new Map<CapabilityKind, boolean>([['https.connect', false]])

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 1, decided)

    expect(content.detail).toContain('[Denied] Connect to a.example')
  })

  it('an item not yet reached carries no [Allowed]/[Denied] marker', () => {
    const manifest = manifestWith({ net: { https: { connect: ['a.example:443'] } }, fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['https.connect', 'fs']

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 0, new Map())

    expect(content.detail).not.toContain('[Allowed]')
    expect(content.detail).not.toContain('[Denied]')
    expect(content.detail).toContain('Store files in a private folder for this app on this device')
  })

  it('switches to "warning" and carries the explanation for an unlimited declaration, same as describeCapabilityGrant', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['tcp.connect']

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 0, new Map())

    expect(content.warning).toBe(true)
    expect(content.message).toContain('Unlimited')
    expect(content.detail).toContain('any computer on the internet')
  })

  it('claims the app\'s name first and the origin last, same house order as every other dialog in this family', () => {
    const manifest = manifestWith({ fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, ['fs'], 0, new Map())

    const lines = content.detail.split('\n')
    expect(lines[0]).toBe(`Claims to be "${manifest.name}".`)
    expect(lines[lines.length - 1]).toBe(ORIGIN)
  })

  it('formats the origin for display the same way every other dialog in this family does (A115/A142)', () => {
    const manifest = manifestWith({ fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const confusable = 'https://accounts.google.com.attacker.example'

    const content = describeCapabilityChoice(confusable, manifest, declared, ['fs'], 0, new Map())

    expect(content.title).toBe('https://...com.attacker.example')
    expect(content.detail).toContain('https://...com.attacker.example')
    expect(content.detail).not.toContain('accounts.google.com.attacker.example')
  })

  it('a single-capability sequence (nothing to choose between) still renders sensibly', () => {
    const manifest = manifestWith({ fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, ['fs'], 0, new Map())

    expect(content.detail).toContain('1 of 1')
    expect(content.message).toBe('Store files in a private folder for this app on this device')
  })

  it('ADR-0037: at level 4, the current row AND every context row lose their warning, not only the one on screen', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } }, fs: {} })
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities: readonly CapabilityKind[] = ['tcp.connect', 'fs']

    const content = describeCapabilityChoice(ORIGIN, manifest, declared, capabilities, 0, new Map(), 4)

    expect(content.warning).toBe(false)
    expect(content.message).toBe('Unlimited network access')
    expect(content.detail).not.toContain('⚠')
    // fs was already narrow, and stays exactly as worded before.
    expect(content.detail).toContain('Store files in a private folder for this app on this device')
  })
})
