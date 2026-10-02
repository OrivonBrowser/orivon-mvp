import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// The three prompts below ask through askQuestion, replaced first, same
// reasoning as install-consent-prompt.test.ts's own header, which this suite
// otherwise mirrors exactly: the wording itself is grant-prompt-
// render.test.ts's job, this only confirms the plumbing (the right spec
// reaches the panel, the right button maps to true/false, the style tracks
// `warning` where the rendered content varies it).

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))
const specOf = (call = 0): Record<string, unknown> | undefined => askQuestion.mock.calls[call]?.[1] as Record<string, unknown> | undefined

const { createCapabilityPrompt, createReconsentPrompt, createRollbackChoicePrompt } = await import('../update-outcomes-prompt.js')

const ORIGIN = 'https://app.example'
const MANIFEST = manifestWith({ fs: {} })

describe('createReconsentPrompt', () => {
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('resolves true when the user picks the first (Use the update) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const prompt = createReconsentPrompt()

    expect(await prompt(ORIGIN, MANIFEST)).toBe(true)
  })

  it('resolves false when the user picks the second (Keep the current version) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const prompt = createReconsentPrompt()

    expect(await prompt(ORIGIN, MANIFEST)).toBe(false)
  })

  it('cancels on, with the first button guarded, "Keep the current version" -- dismissing the question must never accept an update', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createReconsentPrompt()(ORIGIN, MANIFEST)

    expect(specOf()).toMatchObject({
      cancelId: 1,
      guarded: [0],
      kind: 'consent',
      buttons: ['Use the update', 'Keep the current version']
    })
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createReconsentPrompt()(ORIGIN, MANIFEST)

    expect(specOf()).toMatchObject({
      title: ORIGIN,
      message: 'This app has been updated.',
      detail: expect.stringContaining('Its code has changed. What it is allowed to do has not.')
    })
  })

  it('never asks when the caller has already left the origin', async () => {
    const caller = { window: () => undefined, stillOn: () => false }

    const result = await createReconsentPrompt()(ORIGIN, MANIFEST, caller)

    expect(result).toBe(false)
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('asks in the panel of the calling tab and holds that tab until the answer, then releases it', async () => {
    const tab = { id: 'the-tab' }
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab }

    expect(await createReconsentPrompt()(ORIGIN, MANIFEST, caller)).toBe(true)

    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: tab })
    expect(holdNavigation).toHaveBeenCalledWith(tab)
    expect(release).toHaveBeenCalledOnce()
  })

  it('with no caller (an update found in the background) asks in the tab in front and holds nothing', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createReconsentPrompt()(ORIGIN, MANIFEST)

    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: undefined })
    expect(holdNavigation).toHaveBeenCalledWith(undefined)
  })

  it('a question answered by closing the tab (the cancel index) keeps the current version', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    expect(await createReconsentPrompt()(ORIGIN, MANIFEST, { window: () => undefined, stillOn: () => true, contents: () => ({}) })).toBe(false)
  })
})

describe('createCapabilityPrompt', () => {
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('resolves true when the user picks the first (Allow) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const prompt = createCapabilityPrompt()

    expect(await prompt(ORIGIN, MANIFEST, { fs: [] })).toBe(true)
  })

  it('resolves false when the user picks the second (Keep the current version) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const prompt = createCapabilityPrompt()

    expect(await prompt(ORIGIN, MANIFEST, { fs: [] })).toBe(false)
  })

  it('cancels on, with the first button guarded, "Keep the current version" -- dismissing the question must never accept the wider capability', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createCapabilityPrompt()(ORIGIN, MANIFEST, { fs: [] })

    expect(specOf()).toMatchObject({
      cancelId: 1,
      guarded: [0],
      kind: 'consent',
      buttons: ['Allow', 'Keep the current version']
    })
  })

  it('draws the warning style when the requested set is unlimited, the plain style otherwise', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createCapabilityPrompt()(ORIGIN, MANIFEST, { 'https.connect': ['a.example:443'] })
    expect(specOf()).toMatchObject({ warning: false })

    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createCapabilityPrompt()(ORIGIN, MANIFEST, { 'https.connect': ['*:*'] })
    expect(specOf(1)).toMatchObject({ warning: true })
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createCapabilityPrompt()(ORIGIN, MANIFEST, { fs: [] })

    expect(specOf()).toMatchObject({
      title: ORIGIN,
      message: 'This app wants to do more than you already allowed:',
      detail: expect.stringContaining('Store files in a private folder')
    })
  })

  it('ADR-0037: an injected levelOverrideFor returning 4 keeps the plain style even for an unlimited request -- this is the widening prompt, and the override still applies to it', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createCapabilityPrompt((origin) => origin === ORIGIN ? 4 : undefined)(ORIGIN, MANIFEST, { 'https.connect': ['*:*'] })

    expect(specOf()).toMatchObject({ warning: false })
  })

  it('never asks when the caller has already left the origin', async () => {
    const caller = { window: () => undefined, stillOn: () => false }

    const result = await createCapabilityPrompt()(ORIGIN, MANIFEST, { fs: [] }, caller)

    expect(result).toBe(false)
    expect(askQuestion).not.toHaveBeenCalled()
  })
})

describe('createRollbackChoicePrompt', () => {
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('resolves true when the user picks the first (Use this version) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const prompt = createRollbackChoicePrompt()

    expect(await prompt(ORIGIN, MANIFEST, '2.0.0')).toBe(true)
  })

  it('resolves false when the user picks the second (Keep the current version) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const prompt = createRollbackChoicePrompt()

    expect(await prompt(ORIGIN, MANIFEST, '2.0.0')).toBe(false)
  })

  it('cancels on, with the first button guarded, "Keep the current version" -- dismissing the question must never accept the rollback', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0')

    expect(specOf()).toMatchObject({
      cancelId: 1,
      guarded: [0],
      kind: 'consent',
      buttons: ['Use this version', 'Keep the current version']
    })
  })

  // ADR-0037 deliberately never reaches this prompt: the rollback warning
  // is not about a grant's breadth, so createRollbackChoicePrompt takes no
  // level parameter at all -- enforced at compile time, not by a runtime
  // check, since there is no code path here for one to change.
  it('always draws the warning style -- every below-floor offering is the same shape of risk (describeRollbackChoice\'s own doc)', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0')

    expect(specOf()).toMatchObject({ warning: true })
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0')

    expect(specOf()).toMatchObject({
      title: ORIGIN,
      message: 'This app is offering an older version.',
      detail: expect.stringContaining('2.0.0')
    })
  })

  it('never asks when the caller has already left the origin', async () => {
    const caller = { window: () => undefined, stillOn: () => false }

    const result = await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0', caller)

    expect(result).toBe(false)
    expect(askQuestion).not.toHaveBeenCalled()
  })
})
