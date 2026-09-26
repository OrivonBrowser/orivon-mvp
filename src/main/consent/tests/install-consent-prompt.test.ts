import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// createInstallConsentPrompt imports 'electron' at module scope -- mocked
// first, same reasoning as request-grant-prompt.test.ts's own header. This
// suite confirms the plumbing (the right dialog options reach
// dialog.showMessageBox, the right button maps to true/false, the icon
// tracks `warning`) -- WORDING is grant-prompt-render.test.ts's own job.

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { createInstallConsentPrompt } = await import('../install-consent-prompt.js')

const ORIGIN = 'https://app.example'

describe('createInstallConsentPrompt', () => {
  beforeEach(() => { showMessageBox.mockReset() })

  it('resolves true when the user picks the first (Allow) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const consent = createInstallConsentPrompt()

    const result = await consent(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(result).toBe(true)
  })

  it('resolves false when the user picks the second (Deny) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const consent = createInstallConsentPrompt()

    const result = await consent(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(result).toBe(false)
  })

  it('defaults to and cancels on the Deny button -- dismissing the dialog must never grant', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      defaultId: 1,
      cancelId: 1,
      buttons: ['Allow', 'Deny']
    }))
  })

  it('uses the "warning" dialog type when any declared capability is unlimited, "question" otherwise', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['a.example:443'] } } }), ['https.connect'], [])
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'question' }))

    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['*:*'] } } }), ['https.connect'], [])
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const manifest = manifestWith({ fs: {} })

    await createInstallConsentPrompt()(ORIGIN, manifest, ['fs'], [])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: ORIGIN,
      message: 'This app wants to:',
      detail: expect.stringContaining('Store files in a private folder')
    }))
  })

  it('ADR-0037: an injected levelOverrideFor returning 4 for this origin drops the warning dialog type and the ⚠ text', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    await createInstallConsentPrompt((origin) => origin === ORIGIN ? 4 : undefined)(ORIGIN, manifest, ['https.connect'], [])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'question',
      detail: expect.not.stringContaining('⚠')
    }))
  })

  it('with no levelOverrideFor injected, defaults to never overriding -- an unlimited grant still warns', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    await createInstallConsentPrompt()(ORIGIN, manifest, ['https.connect'], [])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })
})
