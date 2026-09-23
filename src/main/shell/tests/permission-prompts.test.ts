import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two questions a page can make the shell ask. `dialog` is replaced so
// nothing is ever shown and the options each question passes can be read
// back; `response` is the button the "person" chose.
const showMessageBox = vi.hoisted(() => vi.fn(async (_window: unknown, _options: Electron.MessageBoxOptions) => ({ response: 0, checkboxChecked: false })))
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { confirmExternalLink, displayableUrl } = await import('../external-link-prompt.js')
const { askNotificationPermission } = await import('../notification-prompt.js')

const WINDOW = { isDestroyed: () => false }

function lastOptions (): Electron.MessageBoxOptions {
  const options = showMessageBox.mock.calls.at(-1)?.[1]
  if (options === undefined) throw new Error('no dialog was shown')
  return options
}

beforeEach(() => { showMessageBox.mockClear() })

describe('confirmExternalLink', () => {
  const question = { scheme: 'magnet', url: 'magnet:?xt=urn:btih:00&dn=film', origin: 'https://tracker.example' }

  it('asks in the given window, naming the scheme, the URL and who is asking', async () => {
    await confirmExternalLink(WINDOW as never, question)
    expect(showMessageBox.mock.calls[0]?.[0]).toBe(WINDOW)
    const options = lastOptions()
    expect(options.message).toBe('Open magnet link with your system\'s default app?')
    expect(options.detail).toBe('https://tracker.example wants to open:\nmagnet:?xt=urn:btih:00&dn=film')
    expect(options.buttons).toEqual(['Allow', 'Cancel'])
  })

  // Enter and Escape must both land on Cancel: a stray key press never
  // launches another app.
  it('defaults to Cancel, and Escape cancels', async () => {
    await confirmExternalLink(WINDOW as never, question)
    const options = lastOptions()
    expect(options.buttons?.[options.defaultId ?? -1]).toBe('Cancel')
    expect(options.buttons?.[options.cancelId ?? -1]).toBe('Cancel')
  })

  it('is true only for Allow', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await confirmExternalLink(WINDOW as never, question)).toBe(true)
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await confirmExternalLink(WINDOW as never, question)).toBe(false)
  })

  it('asks nothing of a window that has closed', async () => {
    expect(await confirmExternalLink({ isDestroyed: () => true } as never, question)).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('shows the origin the way every permission dialog does, keeping the labels that decide who it is', async () => {
    await confirmExternalLink(WINDOW as never, { ...question, origin: 'https://accounts.google.com.attacker.example' })
    expect(lastOptions().detail).toMatch(/^https:\/\/\.\.\.com\.attacker\.example wants to open:/)
  })
})

describe('displayableUrl', () => {
  it('shows a short URL whole', () => {
    expect(displayableUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('cuts a long URL, and says so', () => {
    const shown = displayableUrl(`bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?message=${'x'.repeat(500)}`)
    expect(shown.length).toBeLessThanOrEqual(200)
    expect(shown.endsWith('...')).toBe(true)
  })

  // A bidi override or a line break would let the URL rewrite the lines
  // around it; shown escaped, it can only ever read as itself.
  it('escapes every character that is not printable ASCII', () => {
    expect(displayableUrl('mailto:a@b.example?subject=\u202Etxt.exe\nsecond line')).toBe('mailto:a@b.example?subject=%E2%80%AEtxt.exe%0Asecond line')
  })
})

describe('askNotificationPermission', () => {
  it('asks in the given window with the site first, as the primary line', async () => {
    await askNotificationPermission(WINDOW as never, 'https://chat.example')
    expect(showMessageBox.mock.calls[0]?.[0]).toBe(WINDOW)
    const options = lastOptions()
    expect(options.message).toBe('https://chat.example wants to show notifications')
    expect(options.buttons).toEqual(['Allow', 'Block', 'Not now'])
  })

  it('maps each button to its answer', async () => {
    for (const [response, answer] of [[0, 'allow'], [1, 'block'], [2, 'dismiss']] as const) {
      showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false })
      expect(await askNotificationPermission(WINDOW as never, 'https://chat.example')).toBe(answer)
    }
  })

  // Closing the question is not an answer: Enter and Escape both mean
  // "not now", never "allow".
  it('defaults to Not now, and Escape means Not now', async () => {
    await askNotificationPermission(WINDOW as never, 'https://chat.example')
    const options = lastOptions()
    expect(options.buttons?.[options.defaultId ?? -1]).toBe('Not now')
    expect(options.buttons?.[options.cancelId ?? -1]).toBe('Not now')
  })

  it('asks nothing of a window that has closed, and takes that as no answer', async () => {
    expect(await askNotificationPermission({ isDestroyed: () => true } as never, 'https://chat.example')).toBe('dismiss')
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
