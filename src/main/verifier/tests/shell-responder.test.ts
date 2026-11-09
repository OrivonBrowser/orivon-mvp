import { describe, expect, it, vi } from 'vitest'
import { MAX_RELAYS, RELAY_CHUNK_BYTES, RELAY_WINDOW_BYTES } from '../../../protocols/verifier-host/protocol.js'
import type { RelayRequest, RelayToHost } from '../../../protocols/verifier-host/protocol.js'
import type { AppRequestHandler } from '../../../loader/serve/serve.js'
import { ShellResponder } from '../shell-responder.js'

// The shell's half of a relayed request: the Request the handler is given, what is sent of its Response, and the window
// that keeps a large file from piling up in the host.

const ORIGIN = 'https://kept.example'

function request (id: number, over: Partial<RelayRequest> = {}): RelayRequest {
  return { type: 'relay-request', id, method: 'GET', url: `${ORIGIN}/app.js`, headers: [], ...over }
}

function harness (handlers: Record<string, AppRequestHandler> = {}, up = true): { responder: ShellResponder, sent: RelayToHost[], of: (id: number) => RelayToHost[] } {
  const sent: RelayToHost[] = []
  const responder = new ShellResponder({
    send: (message) => { if (up) sent.push(message); return up },
    handlerFor: (origin) => handlers[origin]
  })
  return { responder, sent, of: (id) => sent.filter((message) => message.id === id) }
}

async function until (check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000; tries += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`never: ${what}`)
}

const bytes = (length: number, fill = 1): Uint8Array => new Uint8Array(length).fill(fill)
const types = (messages: RelayToHost[]): string[] => messages.map((message) => message.type)
function headOf (messages: RelayToHost[]): Extract<RelayToHost, { type: 'relay-head' }> {
  const head = messages.find((message) => message.type === 'relay-head')
  if (head === undefined || head.type !== 'relay-head') throw new Error('no head was sent')
  return head
}
const written = (messages: RelayToHost[]): number => messages.reduce((sum, message) => sum + (message.type === 'relay-body' ? message.chunk.byteLength : 0), 0)

/** A body that yields `chunks`, one per read, and notes whether it was cancelled. */
function bodyOf (chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>, cancelled: () => boolean, pulled: () => number } {
  let at = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull (controller) {
      const next = chunks[at]
      at += 1
      if (next === undefined) controller.close()
      else controller.enqueue(next)
    },
    cancel () { cancelled = true }
  }, { highWaterMark: 0 })
  return { stream, cancelled: () => cancelled, pulled: () => at }
}

describe('the Request a handler is given', () => {
  it('has the method, the address and the headers the host read, and the origin picks the handler', async () => {
    let seen: Request | undefined
    const { responder, of } = harness({ [ORIGIN]: async (given) => { seen = given; return new Response('ok') } })
    responder.receive(request(1, { method: 'GET', url: `${ORIGIN}/dir/app.js?x=1`, headers: [['range', 'bytes=0-1'], ['sec-fetch-mode', 'navigate'], ['accept', 'text/html'], ['accept', 'image/*']] }))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    expect(seen?.url).toBe(`${ORIGIN}/dir/app.js?x=1`)
    expect(seen?.method).toBe('GET')
    expect(seen?.headers.get('range')).toBe('bytes=0-1')
    expect(seen?.headers.get('sec-fetch-mode')).toBe('navigate')
    expect(seen?.headers.get('accept')).toBe('text/html, image/*')
  })

  it('has the method of a request that is not a GET, and no body', async () => {
    const seen: Request[] = []
    const { responder, of } = harness({ [ORIGIN]: async (given) => { seen.push(given); return new Response(null, { status: 204 }) } })
    responder.receive(request(1, { method: 'POST' }))
    responder.receive(request(2, { method: 'OPTIONS' }))
    await until(() => types(of(1)).includes('relay-end') && types(of(2)).includes('relay-end'), 'both answered')
    expect(seen.map((given) => given.method)).toEqual(['POST', 'OPTIONS'])
    expect(seen.every((given) => given.body === null)).toBe(true)
  })

  it('leaves out a header the runtime refuses and keeps the rest', async () => {
    let seen: Request | undefined
    const { responder, of } = harness({ [ORIGIN]: async (given) => { seen = given; return new Response('ok') } })
    responder.receive(request(1, { headers: [['bad name', 'x'], ['x-kept', 'yes']] }))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    expect(seen?.headers.get('x-kept')).toBe('yes')
  })

  it('is aborted when the host says the client left', async () => {
    let signal: AbortSignal | undefined
    const { responder } = harness({ [ORIGIN]: async (given) => { signal = given.signal; return await new Promise<Response>(() => {}) } })
    responder.receive(request(1))
    await until(() => signal !== undefined, 'the handler was called')
    expect(signal?.aborted).toBe(false)
    responder.receive({ type: 'relay-abort', id: 1 })
    expect(signal?.aborted).toBe(true)
  })
})

describe('what is sent of the Response', () => {
  it('is the head with the status and every header, then the bytes, then the end', async () => {
    const { responder, of } = harness({ [ORIGIN]: async () => new Response('hello', { status: 206, headers: { 'content-type': 'text/javascript', 'content-range': 'bytes 0-4/9', 'content-security-policy': "default-src 'self'" } }) })
    responder.receive(request(1))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    const [head, body, end] = of(1)
    expect(head).toMatchObject({ type: 'relay-head', id: 1, status: 206 })
    expect(headOf(of(1)).headers).toEqual(expect.arrayContaining([['content-type', 'text/javascript'], ['content-range', 'bytes 0-4/9'], ['content-security-policy', "default-src 'self'"]]))
    expect(body?.type).toBe('relay-body')
    expect(new TextDecoder().decode((body as { chunk: Uint8Array }).chunk)).toBe('hello')
    expect(end).toEqual({ type: 'relay-end', id: 1 })
  })

  it('is the head and the end alone for an answer with no body', async () => {
    const { responder, of } = harness({ [ORIGIN]: async () => new Response(null, { status: 304 }) })
    responder.receive(request(1))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    expect(types(of(1))).toEqual(['relay-head', 'relay-end'])
    expect(of(1)[0]).toMatchObject({ status: 304 })
  })

  it('keeps a header sent twice as two', async () => {
    const headers = new Headers()
    headers.append('set-cookie', 'a=1')
    headers.append('set-cookie', 'b=2')
    const { responder, of } = harness({ [ORIGIN]: async () => new Response('x', { headers }) })
    responder.receive(request(1))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    expect(headOf(of(1)).headers.filter(([name]) => name === 'set-cookie')).toEqual([['set-cookie', 'a=1'], ['set-cookie', 'b=2']])
  })

  it('sends each piece in a buffer of its own and no larger than a chunk, whatever view of whatever buffer the handler yielded', async () => {
    const backing = new Uint8Array(RELAY_CHUNK_BYTES * 3 + 10).fill(7)
    const view = backing.subarray(5, 5 + RELAY_CHUNK_BYTES * 2 + 3)
    const { responder, of } = harness({ [ORIGIN]: async () => new Response(bodyOf([view]).stream) })
    responder.receive(request(1))
    await until(() => written(of(1)) === view.byteLength, 'the bytes were sent')
    const pieces = of(1).filter((message) => message.type === 'relay-body') as Array<{ chunk: Uint8Array }>
    // The window holds two of the three pieces until the host says it wrote them.
    expect(pieces.length).toBeGreaterThanOrEqual(1)
    for (const piece of pieces) {
      expect(piece.chunk.byteLength).toBeLessThanOrEqual(RELAY_CHUNK_BYTES)
      expect(piece.chunk.buffer.byteLength).toBe(piece.chunk.byteLength)
      expect(piece.chunk.byteOffset).toBe(0)
    }
  })

  it('answers 404 as the retired app\'s partition does, when the shell serves nothing at that origin now', async () => {
    const { responder, of } = harness({})
    responder.receive(request(1))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    expect(of(1)[0]).toMatchObject({ type: 'relay-head', status: 404 })
    expect(new TextDecoder().decode((of(1)[1] as { chunk: Uint8Array }).chunk)).toBe('Orivon: this app was stopped')
  })

  it('asks the handler of the origin in the address and no other, so a host cannot reach another app\'s handler', async () => {
    const asked: string[] = []
    const { responder, of } = harness({ [ORIGIN]: async () => { asked.push(ORIGIN); return new Response('mine') }, 'https://other.example': async () => { asked.push('other'); return new Response('theirs') } })
    responder.receive(request(1, { url: 'https://other.example/app.js' }))
    responder.receive(request(2, { url: 'http://kept.example/app.js' }))
    responder.receive(request(3, { url: 'not an address' }))
    await until(() => [1, 2, 3].every((id) => types(of(id)).includes('relay-end')), 'all answered')
    expect(asked).toEqual(['other'])
    expect(of(2)[0]).toMatchObject({ status: 404 })
    expect(of(3)[0]).toMatchObject({ status: 400 })
  })

  it('refuses a method that is not one, and one the runtime will not build a request for', async () => {
    const { responder, of } = harness({ [ORIGIN]: async () => new Response('ok') })
    responder.receive(request(1, { method: 'GET /x HTTP/1.1' }))
    responder.receive(request(2, { method: 'CONNECT' }))
    await until(() => [1, 2].every((id) => types(of(id)).includes('relay-end')), 'both answered')
    expect(of(1)[0]).toMatchObject({ status: 400 })
    expect(of(2)[0]).toMatchObject({ status: 405 })
  })
})

describe('when the handler cannot answer', () => {
  it('says so, once, when it throws, and keeps what failed to itself', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { responder, of } = harness({ [ORIGIN]: async () => { throw new Error('ENOENT: /home/someone/pins/the-pin') } })
    responder.receive(request(1))
    await until(() => types(of(1)).length > 0, 'an error was sent')
    expect(of(1)).toEqual([{ type: 'relay-error', id: 1, message: 'the shell could not answer' }])
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'ENOENT: /home/someone/pins/the-pin' }))
    log.mockRestore()
  })

  it('says so when it ends the request with a network error, which is a failed load and not a page', async () => {
    const { responder, of } = harness({ [ORIGIN]: async () => Response.error() })
    responder.receive(request(1))
    await until(() => types(of(1)).length > 0, 'an error was sent')
    expect(types(of(1))).toEqual(['relay-error'])
  })

  it('says so when its body fails after the head', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(bytes(4)); controller.error(new Error('the file ended early')) } })
    const { responder, of } = harness({ [ORIGIN]: async () => new Response(failing) })
    responder.receive(request(1))
    await until(() => types(of(1)).includes('relay-error'), 'an error was sent')
    expect(types(of(1))[0]).toBe('relay-head')
    expect(of(1).at(-1)).toMatchObject({ type: 'relay-error', message: 'the shell could not answer' })
    log.mockRestore()
  })

  it('cancels the body of an answer it could not send a head for, and of one that is a network error', async () => {
    const quiet = bodyOf([bytes(10)])
    const refused = harness({ [ORIGIN]: async () => new Response(quiet.stream) }, false)
    refused.responder.receive(request(1))
    await until(() => quiet.cancelled(), 'the body was cancelled')
    const broken = bodyOf([bytes(10)])
    const { responder, of } = harness({ [ORIGIN]: async () => Object.defineProperty(new Response(broken.stream), 'type', { value: 'error' }) })
    responder.receive(request(1))
    await until(() => types(of(1)).length > 0 && broken.cancelled(), 'the body was cancelled')
    expect(types(of(1))).toEqual(['relay-error'])
  })

  it('answers a request number again once the host stopped it, though the handler of the first has not returned', async () => {
    let held = 0
    const { responder, of } = harness({ [ORIGIN]: async (given) => {
      held += 1
      if (held === 1) return await new Promise<Response>(() => {})
      return new Response(new URL(given.url).pathname)
    } })
    responder.receive(request(1))
    await until(() => held === 1, 'the first was handed to its handler')
    responder.receive({ type: 'relay-abort', id: 1 })
    responder.receive(request(1, { url: `${ORIGIN}/second.js` }))
    await until(() => types(of(1)).includes('relay-end'), 'the second was answered')
    expect(of(1).find((message) => message.type === 'relay-body')).toMatchObject({ chunk: new TextEncoder().encode('/second.js') })
  })

  it('says so, and leaves the first alone, when a number still in use comes again', async () => {
    let release: ((response: Response) => void) | undefined
    const { responder, of } = harness({ [ORIGIN]: async () => await new Promise<Response>((resolve) => { release = resolve }) })
    responder.receive(request(1))
    await until(() => release !== undefined, 'the first was handed to its handler')
    responder.receive(request(1))
    expect(of(1)).toEqual([{ type: 'relay-error', id: 1, message: 'the host reused a request number still in use' }])
    release?.(new Response('late'))
    await until(() => types(of(1)).includes('relay-end'), 'the first still ended')
  })

  it('sends nothing for an answer whose request was stopped meanwhile, and cancels its body', async () => {
    const body = bodyOf([bytes(10)])
    let release: ((response: Response) => void) | undefined
    const { responder, sent } = harness({ [ORIGIN]: async () => await new Promise<Response>((resolve) => { release = resolve }) })
    responder.receive(request(1))
    await until(() => release !== undefined, 'the handler was called')
    responder.receive({ type: 'relay-abort', id: 1 })
    release?.(new Response(body.stream))
    await until(() => body.cancelled(), 'the body was cancelled')
    expect(sent).toEqual([])
  })

  it('stops sending when the host is gone', async () => {
    const { responder, sent } = harness({ [ORIGIN]: async () => new Response(bodyOf([bytes(10)]).stream) }, false)
    responder.receive(request(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent).toEqual([])
  })

  it('answers no more than it may at once, and says so for the rest', async () => {
    const { responder, of } = harness({ [ORIGIN]: async () => await new Promise<Response>(() => {}) })
    for (let id = 1; id <= MAX_RELAYS; id += 1) responder.receive(request(id))
    responder.receive(request(MAX_RELAYS + 1))
    await until(() => types(of(MAX_RELAYS + 1)).length > 0, 'the extra request was refused')
    expect(types(of(MAX_RELAYS + 1))).toEqual(['relay-error'])
    responder.abortAll()
  })
})

describe('the window', () => {
  const chunk = RELAY_CHUNK_BYTES
  const total = RELAY_WINDOW_BYTES * 4

  it('holds back the next piece until the host says it wrote the ones before, so a large file never piles up there', async () => {
    const pieces = Array.from({ length: total / chunk }, (_, index) => bytes(chunk, index))
    const body = bodyOf(pieces)
    const { responder, sent, of } = harness({ [ORIGIN]: async () => new Response(body.stream) })
    responder.receive(request(1))
    await until(() => written(of(1)) >= RELAY_WINDOW_BYTES, 'the window was filled')
    await new Promise((resolve) => setTimeout(resolve, 30))
    // No acknowledgement came, so nothing past the window was sent, and the handler's body was not read far ahead either.
    expect(written(sent)).toBe(RELAY_WINDOW_BYTES)
    expect(body.pulled()).toBeLessThanOrEqual(RELAY_WINDOW_BYTES / chunk + 1)
    expect(types(of(1))).not.toContain('relay-end')
  })

  it('lets the next pieces go as the host reports what it wrote, in whatever sizes, until the end', async () => {
    const pieces = Array.from({ length: total / chunk }, (_, index) => bytes(chunk, index))
    const { responder, sent, of } = harness({ [ORIGIN]: async () => new Response(bodyOf(pieces).stream) })
    responder.receive(request(1))
    let acknowledged = 0
    while (!types(of(1)).includes('relay-end')) {
      await until(() => written(sent) > acknowledged || types(of(1)).includes('relay-end'), 'more was sent or the answer ended')
      const pending = written(sent) - acknowledged
      if (pending > 0) {
        const bytesWritten = Math.min(pending, Math.ceil(chunk / 2))
        acknowledged += bytesWritten
        responder.receive({ type: 'relay-wrote', id: 1, bytes: bytesWritten })
      }
      // The host never holds more than the window.
      expect(written(sent) - acknowledged).toBeLessThanOrEqual(RELAY_WINDOW_BYTES)
    }
    expect(written(sent)).toBe(total)
  })

  it('sends a piece larger than the whole window when nothing else is waiting', async () => {
    const one = bytes(chunk)
    const { responder, of } = harness({ [ORIGIN]: async () => new Response(bodyOf([one]).stream) })
    responder.receive(request(1))
    await until(() => types(of(1)).includes('relay-end'), 'the answer ended')
    expect(written(of(1))).toBe(chunk)
  })

  it('stops waiting for the host when the request is stopped, and cancels the handler\'s body', async () => {
    const pieces = Array.from({ length: total / chunk }, () => bytes(chunk))
    const body = bodyOf(pieces)
    const { responder, sent, of } = harness({ [ORIGIN]: async () => new Response(body.stream) })
    responder.receive(request(1))
    await until(() => written(of(1)) >= RELAY_WINDOW_BYTES, 'the window was filled')
    responder.receive({ type: 'relay-abort', id: 1 })
    await until(() => body.cancelled(), 'the body was cancelled')
    const before = sent.length
    responder.receive({ type: 'relay-wrote', id: 1, bytes: RELAY_WINDOW_BYTES })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent.length).toBe(before)
    expect(types(of(1))).not.toContain('relay-end')
  })

  it('stops every request when the host is gone', async () => {
    const bodies = [bodyOf(Array.from({ length: 8 }, () => bytes(chunk))), bodyOf(Array.from({ length: 8 }, () => bytes(chunk)))]
    const { responder, of } = harness({ [ORIGIN]: vi.fn().mockImplementationOnce(async () => new Response(bodies[0]?.stream)).mockImplementationOnce(async () => new Response(bodies[1]?.stream)) })
    responder.receive(request(1))
    responder.receive(request(2))
    await until(() => written(of(1)) > 0 && written(of(2)) > 0, 'both are streaming')
    responder.abortAll()
    await until(() => bodies.every((body) => body.cancelled()), 'both bodies were cancelled')
  })

  it('ignores an acknowledgement for a request it does not hold', () => {
    const { responder } = harness()
    expect(() => { responder.receive({ type: 'relay-wrote', id: 99, bytes: 10 }); responder.receive({ type: 'relay-abort', id: 99 }) }).not.toThrow()
  })
})
