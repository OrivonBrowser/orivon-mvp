// The bridge's one handshake with main: a refusal or no answer at all fails the child's start, and the next start
// asks again, so one bad connect never strands every later child of the page.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { ipc } = vi.hoisted(() => ({
  ipc: { sent: 0, listeners: [] as Array<(event: { ports: unknown[] }) => void> }
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    send: () => { ipc.sent += 1 },
    once: (_channel: string, listener: (event: { ports: unknown[] }) => void) => { ipc.listeners.push(listener) },
    removeListener: (_channel: string, listener: (event: { ports: unknown[] }) => void) => { ipc.listeners = ipc.listeners.filter((each) => each !== listener) }
  }
}))

const { buildChildrenBridge } = await import('../expose-child-host-connect.js')

afterEach(() => {
  vi.useRealTimers()
  ipc.sent = 0
  ipc.listeners = []
})

describe('the children bridge handshake', () => {
  it('fails a start main refused, and asks again on the next start', async () => {
    const bridge = buildChildrenBridge()
    const started = bridge.start({}, () => {})
    ipc.listeners.shift()?.({ ports: [] })
    await expect(started).rejects.toThrow('carried no port')
    void bridge.start({}, () => {}).catch(() => {})
    expect(ipc.sent).toBe(2)
  })

  it('fails a start main never answers, and stops listening for that answer', async () => {
    vi.useFakeTimers()
    const bridge = buildChildrenBridge()
    const started = bridge.start({}, () => {})
    const failed = expect(started).rejects.toThrow('did not answer')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
    expect(ipc.listeners).toHaveLength(0)
  })
})
