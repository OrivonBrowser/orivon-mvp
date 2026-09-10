import { describe, expect, it, vi } from 'vitest'

// showGrantPrompt imports 'electron' at module scope -- outside a real
// Electron process this cannot even be imported without mocking it first
// (same reasoning as tabs.test.ts's own header). Confirms only the plumbing
// (the right question is asked, the right button maps to true/false) --
// what the dialog actually SAYS is explicitly not this file's job, or this
// module's (see request-grant-prompt.ts's own header).

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { showGrantPrompt } = await import('../request-grant-prompt.js')

describe('showGrantPrompt', () => {
  it('resolves true when the user picks the first (Allow) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })

    const result = await showGrantPrompt('https://app.example', 'tcp.connect', ['api.example.com:443'])

    expect(result).toBe(true)
  })

  it('resolves false when the user picks the second (Deny) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    const result = await showGrantPrompt('https://app.example', 'tcp.connect', ['api.example.com:443'])

    expect(result).toBe(false)
  })

  it('names the origin and capability in the message, and lists patterns in the detail', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await showGrantPrompt('https://app.example', 'tcp.connect', ['api.example.com:443', '*.example.com:443'])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('https://app.example'),
      detail: expect.stringContaining('api.example.com:443')
    }))
  })

  it('omits the detail entirely for a capability that carries no patterns (fs, id)', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })

    await showGrantPrompt('https://app.example', 'fs', [])

    const options = showMessageBox.mock.calls.at(-1)?.[0]
    expect(Object.hasOwn(options, 'detail')).toBe(false)
  })
})
