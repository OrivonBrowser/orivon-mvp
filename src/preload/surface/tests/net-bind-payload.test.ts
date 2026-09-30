import { beforeEach, describe, expect, it, vi } from 'vitest'

// net.ts builds its socket bridge from `ipcRenderer` at module scope, so the
// mock offers what that needs and records what `call()` sends.
const invoke = vi.fn()
vi.mock('electron', () => ({ ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args), on: vi.fn(), removeListener: vi.fn() } }))

const { netListenBridge, netUdpBindBridge } = await import('../net.js')

beforeEach(() => { invoke.mockReset() })

/** The payload of the control call the last invoke carried. */
function sentPayload (): unknown {
  const envelope = invoke.mock.calls[0]?.[1] as { payload: unknown }
  return envelope.payload
}

// A missing or non-object argument is the broker's to refuse as 'invalid'
// (its own validators); the preload must not throw a TypeError first.
describe.each([
  ['net.listen', netListenBridge as (opts: unknown) => Promise<unknown>],
  ['net.udpBind', netUdpBindBridge as (opts: unknown) => Promise<unknown>]
])('%s -- an argument that is not an object', (_name, bridge) => {
  it.each([[undefined], [null], [8080], ['8080']])('sends %s to the broker unchanged, and rejects with the broker\'s own answer', async (arg) => {
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'invalid', message: 'requires { port: number }' })
    const rejection = await bridge(arg).then(() => undefined, (error: unknown) => error)
    expect(rejection).not.toBeInstanceOf(TypeError)
    expect(rejection).toMatchObject({ code: 'invalid' })
    expect(sentPayload()).toBe(arg)
  })
})

describe('bindPayload for an object argument', () => {
  it('omits an undefined scope and forwards a given one', async () => {
    invoke.mockResolvedValue({ id: 'r', ok: false, code: 'invalid', message: 'x' })
    await netListenBridge({ port: 8080 }).catch(() => {})
    expect(sentPayload()).toEqual({ port: 8080 })
    expect('scope' in (sentPayload() as object)).toBe(false)
    invoke.mockClear()
    await netListenBridge({ port: 8080, scope: 'local' }).catch(() => {})
    expect(sentPayload()).toEqual({ port: 8080, scope: 'local' })
  })
})
