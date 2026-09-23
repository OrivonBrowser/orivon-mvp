// The stream-end message's `platformCode`: the read side's counterpart of
// write-failed's own, so a peer reset reaches the page as ECONNRESET rather
// than a bare 'reset'. Kept apart from port-pump.test.ts, which covers the
// pump's credit and lifecycle behaviour.
import { describe, expect, it, vi } from 'vitest'
import { createPortPump } from '../port-pump.js'
import type { PortMessage, StreamEndMessage } from '../../../contracts/ipc.js'

const HANDLE = 'handle-1'

function failingStream (error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull (controller) { controller.error(error) } })
}

async function endMessage (error: unknown, code: 'reset' | 'denied' | 'internal'): Promise<StreamEndMessage | undefined> {
  const send = vi.fn()
  createPortPump({ handleId: HANDLE, readable: failingStream(error), send, initialCredit: 1_000, mapError: () => code })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  return send.mock.calls.map((call) => call[0] as PortMessage).find((m): m is StreamEndMessage => m.kind === 'end')
}

describe('createPortPump -- platformCode on an errored end', () => {
  it('carries the raw error\'s errno alongside the mapped code', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(await endMessage(reset, 'reset')).toEqual({ kind: 'end', handleId: HANDLE, code: 'reset', platformCode: 'ECONNRESET' })
  })

  it('omits it when the error carries no errno', async () => {
    expect(await endMessage(new Error('boom'), 'internal')).toEqual({ kind: 'end', handleId: HANDLE, code: 'internal' })
  })

  it('never attaches it to a denial, whatever the error carried', async () => {
    const denied = Object.assign(new Error('refused'), { code: 'EACCES' })
    expect(await endMessage(denied, 'denied')).toEqual({ kind: 'end', handleId: HANDLE, code: 'denied' })
  })
})
