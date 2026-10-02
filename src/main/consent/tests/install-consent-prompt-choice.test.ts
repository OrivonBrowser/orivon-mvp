import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { CapabilityKind, Manifest } from '../../../contracts/index.js'

// createPerCapabilityConsentPrompt (A138's 'per-capability' path,
// docs/open-questions.md) is the real question behind
// PerCapabilityConsentPrompt (./install-consent.ts): a STAGED sequence in the
// calling tab's panel -- one overview offering "allow everything" / "choose
// individually" / "deny everything", then -- only for the middle choice --
// one Allow/Deny question per capability, each one rendering the WHOLE
// request as context (grant-prompt-choice.ts) so a person choosing
// individually never loses sight of what else was asked.

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))
const specOf = (call = 0): Record<string, unknown> | undefined => askQuestion.mock.calls[call]?.[1] as Record<string, unknown> | undefined

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
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('"Allow all" (response 0) accepts everything with a single dialog -- no per-item sequence', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const prompt = createPerCapabilityConsentPrompt()

    const accepted = await prompt(ORIGIN, manifest(), CAPABILITIES)

    expect(accepted).toEqual(CAPABILITIES)
    expect(askQuestion).toHaveBeenCalledOnce()
  })

  it('"Deny all" (response 2) accepts nothing with a single dialog -- no per-item sequence', async () => {
    askQuestion.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    const prompt = createPerCapabilityConsentPrompt()

    const accepted = await prompt(ORIGIN, manifest(), CAPABILITIES)

    expect(accepted).toEqual([])
    expect(askQuestion).toHaveBeenCalledOnce()
  })

  it('the overview offers three buttons, cancelling on "Deny all" with "Allow all" guarded -- dismissing must never grant', async () => {
    askQuestion.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES)

    expect(specOf()).toMatchObject({
      buttons: ['Allow all', 'Choose individually', 'Deny all'],
      cancelId: 2,
      guarded: [0]
    })
  })

  it('the overview renders the same whole-request content describeInstallConsent produces', async () => {
    askQuestion.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    const m = manifest()
    await createPerCapabilityConsentPrompt()(ORIGIN, m, CAPABILITIES)

    expect(specOf()).toMatchObject({
      title: ORIGIN,
      message: 'This app wants to:',
      detail: expect.stringContaining('Connect to a.example')
    })
  })

  it('"Choose individually" (response 1) runs one Allow/Deny dialog per capability, in order', async () => {
    askQuestion
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false }) // overview: choose individually
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false }) // https.connect -> Allow
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false }) // fs -> Deny
    const prompt = createPerCapabilityConsentPrompt()

    const accepted = await prompt(ORIGIN, manifest(), CAPABILITIES)

    expect(accepted).toEqual(['https.connect'])
    expect(askQuestion).toHaveBeenCalledTimes(3)
  })

  it('each per-item question uses Allow/Deny, cancelling on Deny with Allow guarded -- same safe default as every other question in this family', async () => {
    askQuestion
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES)

    const itemCalls = askQuestion.mock.calls.slice(1)
    for (const [, options] of itemCalls) {
      expect(options).toMatchObject({ buttons: ['Allow', 'Deny'], cancelId: 1, guarded: [0] })
    }
  })

  it('each per-item dialog\'s content is exactly describeCapabilityChoice\'s own rendering -- one vocabulary, not two', async () => {
    askQuestion
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES)

    const firstItemArgs = askQuestion.mock.calls[1]?.[1]
    const secondItemArgs = askQuestion.mock.calls[2]?.[1]
    expect(firstItemArgs).toMatchObject({ message: 'Connect to a.example' })
    expect(firstItemArgs?.detail).toContain('1 of 2')
    expect(secondItemArgs).toMatchObject({ message: 'Store files in a private folder for this app on this device' })
    expect(secondItemArgs?.detail).toContain('2 of 2')
    // The second screen already knows the first was allowed -- proving the
    // sequence actually threads decisions through, not just button clicks.
    expect(secondItemArgs?.detail).toContain('[Allowed] Connect to a.example')
  })

  it('a single-capability manifest still goes through the overview -- no special-cased shortcut that skips it', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const accepted = await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), ['fs'])

    expect(accepted).toEqual(['fs'])
    expect(askQuestion).toHaveBeenCalledOnce()
  })

  it('switches to "warning" for an unlimited declaration, on the overview and on that item\'s own screen', async () => {
    const wide: Manifest = { ...manifestWith({ net: { tcp: { connect: ['*:*'] } } }), consentGranularity: 'per-capability' }
    askQuestion
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false }) // choose individually
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false }) // deny the one item
    await createPerCapabilityConsentPrompt()(ORIGIN, wide, ['tcp.connect'])

    expect(askQuestion.mock.calls[0]?.[1]).toMatchObject({ warning: true })
    expect(askQuestion.mock.calls[1]?.[1]).toMatchObject({ warning: true })
  })

  it('holds the tab for the whole sequence, the gaps between screens included, and releases it once', async () => {
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    const heldDuring: boolean[] = []
    const answers = [1, 0, 1]
    askQuestion.mockImplementation(async () => {
      heldDuring.push(release.mock.calls.length === 0)
      return { response: answers.shift() ?? 1, checkboxChecked: false }
    })
    const tab = {}
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab }

    await createPerCapabilityConsentPrompt()(ORIGIN, manifest(), CAPABILITIES, caller)

    expect(holdNavigation).toHaveBeenCalledOnce()
    expect(heldDuring).toEqual([true, true, true])
    expect(release).toHaveBeenCalledOnce()
    expect(askQuestion.mock.calls.every((call) => (call[0] as { contents: unknown }).contents === tab)).toBe(true)
  })

  it('extensions disclosure: an injected extensionsOnSite reaches the overview screen', async () => {
    const extensionsOnSite = vi.fn(async (origin: string) => origin === ORIGIN ? ['Ad Blocker'] : [])
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false }) // allow all
    await createPerCapabilityConsentPrompt(undefined, extensionsOnSite)(ORIGIN, manifest(), CAPABILITIES)

    expect(extensionsOnSite).toHaveBeenCalledWith(ORIGIN)
    const overviewArgs = askQuestion.mock.calls[0]?.[1]
    expect(overviewArgs?.detail).toContain('Extensions that can also act on this site: Ad Blocker.')
  })
})
