import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { CapabilityKind, Manifest } from '../../../contracts/index.js'

// createPerCapabilityConsentPrompt (A138's 'per-capability' path,
// docs/open-questions.md) is the real dialog behind PerCapabilityConsentPrompt
// (./install-consent.ts). Still no new dependency, no custom window (Rule 8;
// install-consent-prompt.ts's own header) -- a native dialog.showMessageBox
// cannot show a checkbox list, so this is a STAGED sequence of native
// dialogs instead: one overview offering "allow everything" / "choose
// individually" / "deny everything", then -- only for the middle choice --
// one Allow/Deny dialog per capability, each one rendering the WHOLE
// request as context (grant-prompt-choice.ts) so a person choosing
// individually never loses sight of what else was asked.

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { createPerCapabilityConsentPrompt } = await import('../install-consent-prompt.js')

const ORIGIN = 'https://app.example'

function manifest (): Manifest {
  return {
    ...manifestWith({ net: { https: { connect: ['a.example:443'] } }, fs: { quotaBytes: 1024 } }),
    consentGranularity: 'per-capability'
  }
}

const CAPABILITIES: readonly CapabilityKind[] = ['https.connect', 'fs']

describe('createPerCapabilityConsentPrompt', () => {
  beforeEach(() => { showMessageBox.mockReset() })

  it('"Allow all" (response 0) accepts everything with a single dialog -- no per-item sequence', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const prompt = createPerCapabilityConsentPrompt()

    const accepted = await prompt(ORIGIN, manifest(), CAPABILITIES)

    expect(accepted).toEqual(CAPABILITIES)
    expect(showMessageBox).toHaveBeenCalledOnce()
  })

  it('"Deny all" (response 2) accepts nothing with a single dialog -- no per-item sequence', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    const prompt = createPerCapabilityConsentPrompt()

    const accepted = await prompt(ORIGIN, manifest(), CAPABILITIES)

    expect(accepted).toEqual([])
    expect(showMessageBox).toHaveBeenCalledOnce()
  })

  it('the overview offers three buttons, defaulting and cancelling on "Deny all" -- dismissing must never grant', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES)

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['Allow all', 'Choose individually', 'Deny all'],
      defaultId: 2,
      cancelId: 2
    }))
  })

  it('the overview renders the same whole-request content describeInstallConsent produces', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    const m = manifest()
    await createPerCapabilityConsentPrompt()(ORIGIN, m, CAPABILITIES)

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: ORIGIN,
      message: 'This app wants to:',
      detail: expect.stringContaining('Connect to a.example')
    }))
  })

  it('"Choose individually" (response 1) runs one Allow/Deny dialog per capability, in order', async () => {
    showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // overview: choose individually
      .mockResolvedValueOnce({ response: 0 }) // https.connect -> Allow
      .mockResolvedValueOnce({ response: 1 }) // fs -> Deny
    const prompt = createPerCapabilityConsentPrompt()

    const accepted = await prompt(ORIGIN, manifest(), CAPABILITIES)

    expect(accepted).toEqual(['https.connect'])
    expect(showMessageBox).toHaveBeenCalledTimes(3)
  })

  it('each per-item dialog uses Allow/Deny, defaulting and cancelling on Deny -- same safe default as every other native dialog in this family', async () => {
    showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES)

    const itemCalls = showMessageBox.mock.calls.slice(1)
    for (const [options] of itemCalls) {
      expect(options).toMatchObject({ buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1 })
    }
  })

  it('each per-item dialog\'s content is exactly describeCapabilityChoice\'s own rendering -- one vocabulary, not two', async () => {
    showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 })
    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES)

    const firstItemArgs = showMessageBox.mock.calls[1]?.[0]
    const secondItemArgs = showMessageBox.mock.calls[2]?.[0]
    expect(firstItemArgs).toMatchObject({ message: 'Connect to a.example' })
    expect(firstItemArgs?.detail).toContain('1 of 2')
    expect(secondItemArgs).toMatchObject({ message: 'Store files in a private folder for this app on this device' })
    expect(secondItemArgs?.detail).toContain('2 of 2')
    // The second screen already knows the first was allowed -- proving the
    // sequence actually threads decisions through, not just button clicks.
    expect(secondItemArgs?.detail).toContain('[Allowed] Connect to a.example')
  })

  it('a single-capability manifest still goes through the overview -- no special-cased shortcut that skips it', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const accepted = await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), ['fs'])

    expect(accepted).toEqual(['fs'])
    expect(showMessageBox).toHaveBeenCalledOnce()
  })

  it('switches to "warning" for an unlimited declaration, on the overview and on that item\'s own screen', async () => {
    const wide: Manifest = { ...manifestWith({ net: { tcp: { connect: ['*:*'] } } }), consentGranularity: 'per-capability' }
    showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // choose individually
      .mockResolvedValueOnce({ response: 1 }) // deny the one item
    await createPerCapabilityConsentPrompt()(ORIGIN, wide, ['tcp.connect'])

    expect(showMessageBox.mock.calls[0]?.[0]).toMatchObject({ type: 'warning' })
    expect(showMessageBox.mock.calls[1]?.[0]).toMatchObject({ type: 'warning' })
  })
})
