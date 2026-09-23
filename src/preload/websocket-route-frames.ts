// The RFC 6455 client codec the routed WebSocket speaks over `orivon.net`:
// frames out (always masked), frames in (validated and reassembled), and the
// opening handshake's key and checks. No extension is ever offered, so every
// reserved bit on an inbound frame is a protocol error.
//
// `installWebSocketFrames` is SERIALISED into the main world (see
// ./routed-wire.ts's header) and publishes `webSocketFrames` on the shared
// slot for ./websocket-route.ts.
import type { ResponseHead } from './fetch-route-types.js'
import type { WebSocketInbound, WebSocketProtocolError, WebSocketRouteTarget, WebSocketSlot } from './websocket-route-types.js'

export function installWebSocketFrames (
  isAppTab: boolean,
  target: WebSocketRouteTarget = typeof window === 'undefined' ? {} : window as unknown as WebSocketRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, WebSocketSlot | undefined>)[Symbol.for('orivon.routed-network')]
  if (slot === undefined) return

  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC11B18'
  const OPCODES = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 }
  const KNOWN_OPCODES = [0, 1, 2, 8, 9, 10]
  const MAX_CONTROL_PAYLOAD = 125
  // Each write hands the broker a buffer of its own, at most this large.
  const PIECE_BYTES = 64 * 1024
  // A 64-bit length past 2^53 cannot be counted in a JS number.
  const MAX_HIGH_WORD = 0x1fffff

  function protocolError (closeCode: number, message: string): WebSocketProtocolError {
    return { closeCode, message }
  }

  function base64 (data: Uint8Array): string {
    return btoa(String.fromCharCode(...data))
  }

  function key (): string {
    return base64(crypto.getRandomValues(new Uint8Array(16)))
  }

  function encode (opcode: number, payload: Uint8Array): Uint8Array[] {
    const length = payload.byteLength
    const extended = length < 126 ? 0 : length < 65536 ? 2 : 8
    const head = new Uint8Array(2 + extended + 4)
    head[0] = 0x80 | opcode
    if (extended === 0) head[1] = 0x80 | length
    else if (extended === 2) {
      head[1] = 0x80 | 126
      head[2] = length >>> 8
      head[3] = length & 0xff
    } else {
      head[1] = 0x80 | 127
      const view = new DataView(head.buffer)
      view.setUint32(2, Math.floor(length / 2 ** 32))
      view.setUint32(6, length >>> 0)
    }
    const mask = crypto.getRandomValues(new Uint8Array(4))
    head.set(mask, 2 + extended)
    const pieces: Uint8Array[] = []
    let at = 0
    do {
      const lead = pieces.length === 0 ? head.byteLength : 0
      const n = Math.min(PIECE_BYTES - lead, length - at)
      const piece = new Uint8Array(lead + n)
      if (lead > 0) piece.set(head)
      for (let i = 0; i < n; i++) piece[lead + i] = payload[at + i]! ^ mask[(at + i) & 3]!
      pieces.push(piece)
      at += n
    } while (at < length)
    return pieces
  }

  function closePayload (code: number | undefined, reason: Uint8Array): Uint8Array {
    if (code === undefined) return new Uint8Array(0)
    const out = new Uint8Array(2 + reason.byteLength)
    out[0] = code >>> 8
    out[1] = code & 0xff
    out.set(reason, 2)
    return out
  }

  /** The codes RFC 6455 and its IANA registry allow on the wire; 1005, 1006 and 1015 are for reporting only. */
  function validCloseCode (code: number): boolean {
    return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
  }

  /** One buffer holding exactly `pieces`, so a binary message's `.buffer` exposes nothing else. */
  function join (pieces: Uint8Array[], size: number): Uint8Array {
    const only = pieces[0]
    if (pieces.length === 1 && only !== undefined && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength) return only
    const out = new Uint8Array(size)
    let at = 0
    for (const piece of pieces) { out.set(piece, at); at += piece.byteLength }
    return out
  }

  interface Frame { readonly fin: boolean, readonly opcode: number, readonly length: number, received: number, readonly pieces: Uint8Array[] }

  function parser (): { feed: (chunk: Uint8Array) => WebSocketInbound[] } {
    // BOM kept: a message's text is exactly what was sent.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const header = new Uint8Array(10)
    let headerLength = 0
    let frame: Frame | undefined
    let message: { opcode: number, pieces: Uint8Array[], size: number } | undefined

    function headerNeeded (): number {
      if (headerLength < 2) return 2
      const code = header[1]! & 0x7f
      return code === 126 ? 4 : code === 127 ? 10 : 2
    }

    function text (data: Uint8Array): string {
      try { return decoder.decode(data) } catch { throw protocolError(1007, 'Could not decode a text frame as UTF-8.') }
    }

    function startFrame (): Frame {
      const b0 = header[0]!
      const b1 = header[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      if ((b0 & 0x70) !== 0) throw protocolError(1002, 'One or more reserved bits are on.')
      if ((b1 & 0x80) !== 0) throw protocolError(1002, 'A server must not mask any frames that it sends to the client.')
      if (!KNOWN_OPCODES.includes(opcode)) throw protocolError(1002, `Unrecognized frame opcode: ${opcode}`)
      let length = b1 & 0x7f
      if (length === 126) length = (header[2]! << 8) | header[3]!
      else if (length === 127) {
        const view = new DataView(header.buffer)
        const high = view.getUint32(2)
        if (high > MAX_HIGH_WORD) throw protocolError(1009, 'The frame is too large.')
        length = high * 2 ** 32 + view.getUint32(6)
      }
      if (opcode >= OPCODES.close) {
        if (!fin) throw protocolError(1002, 'Received fragmented control frame.')
        if (length > MAX_CONTROL_PAYLOAD) throw protocolError(1002, 'Received a control frame with a payload over 125 bytes.')
      } else if (opcode === OPCODES.continuation) {
        if (message === undefined) throw protocolError(1002, 'Received unexpected continuation frame.')
      } else if (message !== undefined) {
        throw protocolError(1002, 'Received start of new message but previous message is unfinished.')
      }
      return { fin, opcode, length, received: 0, pieces: [] }
    }

    function control (opcode: number, payload: Uint8Array): WebSocketInbound {
      if (opcode === OPCODES.ping) return { kind: 'ping', data: payload }
      if (opcode === OPCODES.pong) return { kind: 'pong' }
      if (payload.byteLength === 0) return { kind: 'close', code: 1005, reason: '' }
      if (payload.byteLength === 1) throw protocolError(1002, 'Received a broken close frame containing only one byte.')
      const code = (payload[0]! << 8) | payload[1]!
      if (!validCloseCode(code)) throw protocolError(1002, `Received a broken close frame containing an invalid status code ${code}.`)
      return { kind: 'close', code, reason: text(payload.subarray(2)) }
    }

    function finishFrame (done: Frame, out: WebSocketInbound[]): void {
      const payload = join(done.pieces, done.length)
      if (done.opcode >= OPCODES.close) { out.push(control(done.opcode, payload)); return }
      const current = message ?? { opcode: done.opcode, pieces: [], size: 0 }
      message = current
      current.pieces.push(payload)
      current.size += payload.byteLength
      if (!done.fin) return
      message = undefined
      const whole = join(current.pieces, current.size)
      out.push(current.opcode === OPCODES.text ? { kind: 'text', data: text(whole) } : { kind: 'binary', data: whole })
    }

    function feed (chunk: Uint8Array): WebSocketInbound[] {
      const out: WebSocketInbound[] = []
      let i = 0
      while (i < chunk.byteLength) {
        if (frame === undefined) {
          while (headerLength < headerNeeded() && i < chunk.byteLength) header[headerLength++] = chunk[i++]!
          if (headerLength < headerNeeded()) break
          headerLength = 0
          const started = startFrame()
          if (started.length > 0) frame = started
          else finishFrame(started, out)
          continue
        }
        const n = Math.min(frame.length - frame.received, chunk.byteLength - i)
        frame.pieces.push(chunk.subarray(i, i + n))
        frame.received += n
        i += n
        if (frame.received === frame.length) { finishFrame(frame, out); frame = undefined }
      }
      return out
    }

    return { feed }
  }

  function values (head: ResponseHead, name: string): string[] {
    return head.headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v.trim())
  }

  /** The WHATWG "establish a WebSocket connection" checks, with Chromium's wording for each failure. */
  async function checkHandshake (head: ResponseHead, sentKey: string, protocols: readonly string[]): Promise<string> {
    if (head.status !== 101) throw new Error(`Unexpected response code: ${head.status}`)
    const upgrade = values(head, 'upgrade')
    if (upgrade.length !== 1 || upgrade[0]!.toLowerCase() !== 'websocket') throw new Error(`'Upgrade' header value is not 'WebSocket': ${upgrade.join(', ')}`)
    const connection = values(head, 'connection').join(',').split(',').map((t) => t.trim().toLowerCase())
    if (!connection.includes('upgrade')) throw new Error("'Connection' header value must contain 'Upgrade'")
    const accept = values(head, 'sec-websocket-accept')
    if (accept.length !== 1) throw new Error(accept.length === 0 ? "'Sec-WebSocket-Accept' header is missing" : "'Sec-WebSocket-Accept' header must not appear more than once in a response")
    if (typeof crypto.subtle?.digest !== 'function') throw new Error('this page is not a secure context, so Sec-WebSocket-Accept cannot be verified')
    const expected = base64(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(sentKey + GUID))))
    if (accept[0] !== expected) throw new Error("Incorrect 'Sec-WebSocket-Accept' header value")
    const extensions = values(head, 'sec-websocket-extensions').join(', ')
    if (extensions !== '') throw new Error(`Response must not include 'Sec-WebSocket-Extensions' header if not present in request: ${extensions}`)
    const chosen = values(head, 'sec-websocket-protocol')
    if (chosen.length > 1) throw new Error("'Sec-WebSocket-Protocol' header must not appear more than once in a response")
    const protocol = chosen[0] ?? ''
    if (chosen.length === 1 && protocols.length === 0) throw new Error("Response must not include 'Sec-WebSocket-Protocol' header if not present in request")
    if (protocols.length > 0 && protocol === '') throw new Error("Sent non-empty 'Sec-WebSocket-Protocol' header but no response was received")
    if (protocol !== '' && !protocols.includes(protocol)) throw new Error(`'Sec-WebSocket-Protocol' header value '${protocol}' in response does not match any of sent values`)
    return protocol
  }

  slot.webSocketFrames = {
    opcodes: { text: OPCODES.text, binary: OPCODES.binary, close: OPCODES.close, ping: OPCODES.ping, pong: OPCODES.pong },
    encode,
    closePayload,
    parser,
    key,
    checkHandshake
  }
}
