import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionInstallDescription } from '../../../broker/policy/extension-manifest.js'

// createExtensionInstallPrompt imports 'electron' at module scope -- mocked
// first, same reasoning as ../../consent/tests/install-consent-prompt.test.ts's
// own header. This suite confirms the plumbing (the right dialog options
// reach dialog.showMessageBox, the right button maps to true/false, the
// type tracks `warning`) -- wording is extension-manifest.test.ts's job.

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { createExtensionInstallPrompt } = await import('../extension-install-prompt.js')

const DESCRIPTION: ExtensionInstallDescription = {
  title: 'Load "Fixture"?',
  message: 'Fixture',
  detail: 'Read and change all your data on all websites',
  warning: true
}

describe('createExtensionInstallPrompt', () => {
  beforeEach(() => { showMessageBox.mockReset() })

  it('resolves true when the person picks the first (Add extension) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const prompt = createExtensionInstallPrompt()
    expect(await prompt(DESCRIPTION)).toBe(true)
  })

  it('resolves false when the person picks the second (Cancel) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const prompt = createExtensionInstallPrompt()
    expect(await prompt(DESCRIPTION)).toBe(false)
  })

  it('defaults to and cancels on Cancel -- dismissing the dialog must never install', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await createExtensionInstallPrompt()(DESCRIPTION)
    const options = showMessageBox.mock.calls[0]?.[0]
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.buttons).toEqual(['Add extension', 'Cancel'])
  })

  it('shows a warning dialog when the description warns, and a question otherwise', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    await createExtensionInstallPrompt()(DESCRIPTION)
    expect(showMessageBox.mock.calls[0]?.[0].type).toBe('warning')

    showMessageBox.mockClear()
    await createExtensionInstallPrompt()({ ...DESCRIPTION, warning: false })
    expect(showMessageBox.mock.calls[0]?.[0].type).toBe('question')
  })

  it('passes the description\'s title/message/detail straight through', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await createExtensionInstallPrompt()(DESCRIPTION)
    const options = showMessageBox.mock.calls[0]?.[0]
    expect(options.title).toBe(DESCRIPTION.title)
    expect(options.message).toBe(DESCRIPTION.message)
    expect(options.detail).toBe(DESCRIPTION.detail)
  })
})
