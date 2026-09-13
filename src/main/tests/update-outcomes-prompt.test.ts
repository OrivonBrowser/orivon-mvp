import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../broker/tests/index.test-helpers.js'

// The three prompts below import 'electron' at module scope -- mocked first,
// same reasoning as install-consent-prompt.test.ts's own header, which this
// suite otherwise mirrors exactly: the wording itself is grant-prompt-
// render.test.ts's job, this only confirms the plumbing (the right dialog
// options reach dialog.showMessageBox, the right button maps to true/false,
// the icon tracks `warning` where the rendered content varies it).

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { createCapabilityPrompt, createReconsentPrompt, createRollbackChoicePrompt } = await import('../update-outcomes-prompt.js')

const ORIGIN = 'https://app.example'
const MANIFEST = manifestWith({ fs: {} })

describe('createReconsentPrompt', () => {
  beforeEach(() => { showMessageBox.mockReset() })

  it('resolves true when the user picks the first (Use the update) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const prompt = createReconsentPrompt()

    expect(await prompt(ORIGIN, MANIFEST)).toBe(true)
  })

  it('resolves false when the user picks the second (Keep the current version) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const prompt = createReconsentPrompt()

    expect(await prompt(ORIGIN, MANIFEST)).toBe(false)
  })

  it('defaults to and cancels on "Keep the current version" -- dismissing the dialog must never accept an update', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createReconsentPrompt()(ORIGIN, MANIFEST)

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      defaultId: 1,
      cancelId: 1,
      buttons: ['Use the update', 'Keep the current version']
    }))
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createReconsentPrompt()(ORIGIN, MANIFEST)

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: ORIGIN,
      message: 'This app has been updated.',
      detail: expect.stringContaining('Its code has changed. What it is allowed to do has not.')
    }))
  })
})

describe('createCapabilityPrompt', () => {
  beforeEach(() => { showMessageBox.mockReset() })

  it('resolves true when the user picks the first (Allow) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const prompt = createCapabilityPrompt()

    expect(await prompt(ORIGIN, MANIFEST, { fs: [] })).toBe(true)
  })

  it('resolves false when the user picks the second (Keep the current version) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const prompt = createCapabilityPrompt()

    expect(await prompt(ORIGIN, MANIFEST, { fs: [] })).toBe(false)
  })

  it('defaults to and cancels on "Keep the current version" -- dismissing the dialog must never accept the wider capability', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createCapabilityPrompt()(ORIGIN, MANIFEST, { fs: [] })

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      defaultId: 1,
      cancelId: 1,
      buttons: ['Allow', 'Keep the current version']
    }))
  })

  it('uses the "warning" dialog type when the requested set is unlimited, "question" otherwise', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await createCapabilityPrompt()(ORIGIN, MANIFEST, { 'https.connect': ['a.example:443'] })
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'question' }))

    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await createCapabilityPrompt()(ORIGIN, MANIFEST, { 'https.connect': ['*:*'] })
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createCapabilityPrompt()(ORIGIN, MANIFEST, { fs: [] })

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: ORIGIN,
      message: 'This app wants to do more than you already allowed:',
      detail: expect.stringContaining('Store files in a private folder')
    }))
  })
})

describe('createRollbackChoicePrompt', () => {
  beforeEach(() => { showMessageBox.mockReset() })

  it('resolves true when the user picks the first (Use this version) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const prompt = createRollbackChoicePrompt()

    expect(await prompt(ORIGIN, MANIFEST, '2.0.0')).toBe(true)
  })

  it('resolves false when the user picks the second (Keep the current version) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const prompt = createRollbackChoicePrompt()

    expect(await prompt(ORIGIN, MANIFEST, '2.0.0')).toBe(false)
  })

  it('defaults to and cancels on "Keep the current version" -- dismissing the dialog must never accept the rollback', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0')

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      defaultId: 1,
      cancelId: 1,
      buttons: ['Use this version', 'Keep the current version']
    }))
  })

  it('always uses the "warning" dialog type -- every below-floor offering is the same shape of risk (describeRollbackChoice\'s own doc)', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0')

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createRollbackChoicePrompt()(ORIGIN, MANIFEST, '2.0.0')

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: ORIGIN,
      message: 'This app is offering an older version.',
      detail: expect.stringContaining('2.0.0')
    }))
  })
})
