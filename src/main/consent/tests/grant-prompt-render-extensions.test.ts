import { describe, expect, it } from 'vitest'
import { describeGrantRequest, describeInstallConsent } from '../grant-prompt-render.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// N2's disclosure (docs/planning/extensions-exploration.md, "disclose where
// it matters"): the one line `describeGrantRequest` and `describeInstallConsent`
// gain when an extension's host access also covers the origin being decided
// about. In its own sibling file for the same reason grant-prompt-render-
// embed.test.ts and grant-prompt-render-web-context.test.ts are -- these are
// wording tests, and grant-prompt-render.test.ts stays under Rule 2's
// 800-line test budget.

const ORIGIN = 'https://app.example'

describe('describeGrantRequest -- extensionsOnSite (N2)', () => {
  it('adds no extensions line when none reach the site (no regression, empty default)', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [])

    expect(content.detail).not.toContain('Extensions that can also act on this site')
  })

  it('names up to three extensions, still keeping the origin last', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [], undefined, ['A', 'B'])

    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      'Extensions that can also act on this site: A, B. Orivon keeps their code from using what you grant here, but they can change what the site shows and sends.\n' +
      'https://app.example'
    )
  })

  it('a fourth name and beyond collapses to a count', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [], undefined, ['A', 'B', 'C', 'D', 'E'])

    expect(content.detail).toContain('Extensions that can also act on this site: A, B, C, and 2 more.')
  })
})

describe('describeInstallConsent -- extensionsOnSite (N2)', () => {
  it('the extensions line sits after the capability rows, before the closing origin', () => {
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })

    const content = describeInstallConsent(ORIGIN, manifest, ['fs'], [], undefined, ['Ad Blocker'])

    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      '- Store files in a private folder for this app on this device\n' +
      'Extensions that can also act on this site: Ad Blocker. Orivon keeps their code from using what you grant here, but they can change what the site shows and sends.\n' +
      'https://app.example'
    )
  })

  it('defaults to none -- every pre-existing call site is unaffected', () => {
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })

    const content = describeInstallConsent(ORIGIN, manifest, ['fs'])

    expect(content.detail).not.toContain('Extensions that can also act on this site')
  })
})
