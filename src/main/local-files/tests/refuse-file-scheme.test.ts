import { describe, expect, it, vi } from 'vitest'
import { refuseFileScheme } from '../refuse-file-scheme.js'

function fakeSession (handled: boolean): { protocol: { isProtocolHandled: (scheme: string) => boolean, handle: ReturnType<typeof vi.fn> } } {
  return { protocol: { isProtocolHandled: (scheme) => scheme === 'file' && handled, handle: vi.fn() } }
}

describe('refuseFileScheme -- a session that is not a local-files session loads no file', () => {
  it('handles file: with a 404 on a session that does not handle it yet', async () => {
    const target = fakeSession(false)
    refuseFileScheme(target as unknown as Parameters<typeof refuseFileScheme>[0])

    expect(target.protocol.handle).toHaveBeenCalledOnce()
    const [scheme, handler] = target.protocol.handle.mock.calls[0] as [string, () => Response]
    expect(scheme).toBe('file')
    const response = handler()
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('secret')
  })

  it('leaves a session that already handles file: alone, so a later call cannot undo a local session', () => {
    const target = fakeSession(true)
    refuseFileScheme(target as unknown as Parameters<typeof refuseFileScheme>[0])

    expect(target.protocol.handle).not.toHaveBeenCalled()
  })
})
