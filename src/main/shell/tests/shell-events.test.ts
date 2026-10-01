import { describe, expect, it, vi } from 'vitest'
import { SHELL_EVENT_CHANNEL } from '../../channels.js'
import { sendChromeEvent } from '../shell-events.js'

describe('sendChromeEvent', () => {
  it('sends the payload to the named module over the shell event channel', () => {
    const send = vi.fn()
    const window = { chrome: { webContents: { isDestroyed: () => false, send } } }

    sendChromeEvent(window as never, 'downloads', { count: 2 })

    expect(send).toHaveBeenCalledWith(SHELL_EVENT_CHANNEL, { type: 'module', module: 'downloads', payload: { count: 2 } })
  })

  it('sends nothing once the chrome is gone', () => {
    const send = vi.fn()
    const window = { chrome: { webContents: { isDestroyed: () => true, send } } }

    sendChromeEvent(window as never, 'downloads', {})

    expect(send).not.toHaveBeenCalled()
  })
})
