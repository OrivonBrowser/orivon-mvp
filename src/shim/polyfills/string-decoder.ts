// `string_decoder` module target (module-map.ts), hand-written. utf8 and
// utf16le decode through TextDecoder in streaming mode, so a character split
// across chunks is held until it completes; base64 holds back bytes short of
// a whole 3-byte group; every other encoding is one byte per character and
// needs no state.

import { Buffer } from 'buffer'
import { decode } from '../encoding.js'
import { nodeModule } from './module-proxy.js'

const TEXT_DECODER_LABELS: Readonly<Record<string, string>> = {
  utf8: 'utf-8', 'utf-8': 'utf-8', utf16le: 'utf-16le', 'utf-16le': 'utf-16le', ucs2: 'utf-16le', 'ucs-2': 'utf-16le'
}

export class StringDecoder {
  readonly encoding: string
  private readonly text: TextDecoder | undefined
  private pending = new Uint8Array(0)

  constructor (encoding = 'utf8') {
    const lower = encoding.toLowerCase()
    this.encoding = lower === 'utf-8' ? 'utf8' : lower
    const label = TEXT_DECODER_LABELS[lower]
    this.text = label === undefined ? undefined : new TextDecoder(label)
    if (label === undefined) decode(new Uint8Array(0), lower)
  }

  write (chunk: Uint8Array | string): string {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (this.text !== undefined) return this.text.decode(bytes, { stream: true })
    if (!this.encoding.startsWith('base64')) return decode(bytes, this.encoding) as string
    const joined = Buffer.concat([this.pending, bytes])
    const whole = joined.length - (joined.length % 3)
    this.pending = joined.subarray(whole)
    return decode(joined.subarray(0, whole), this.encoding) as string
  }

  end (chunk?: Uint8Array | string): string {
    const head = chunk === undefined ? '' : this.write(chunk)
    if (this.text !== undefined) return head + this.text.decode()
    const tail = this.pending.length === 0 ? '' : decode(this.pending, this.encoding) as string
    this.pending = new Uint8Array(0)
    return head + tail
  }
}

export default nodeModule('string_decoder', { StringDecoder })
