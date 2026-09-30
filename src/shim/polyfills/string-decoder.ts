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

interface DecoderInternals {
  text: TextDecoder | undefined
  pending: Uint8Array
}

export interface StringDecoder {
  readonly encoding: string
  write (chunk: Uint8Array | string): string
  end (chunk?: Uint8Array | string): string
}

export interface StringDecoderConstructor {
  new (encoding?: string): StringDecoder
  readonly prototype: StringDecoder
}

const internals = new WeakMap<object, DecoderInternals>()

/**
 * A function, not a class: `iconv-lite` (through body-parser, so every express app) builds its
 * decoder with `StringDecoder.call(this, encoding)`, which a class constructor refuses.
 */
export const StringDecoder = function StringDecoder (this: object, encoding = 'utf8'): void {
  const lower = encoding.toLowerCase()
  const label = TEXT_DECODER_LABELS[lower]
  if (label === undefined) decode(new Uint8Array(0), lower)
  Object.defineProperty(this, 'encoding', { value: lower === 'utf-8' ? 'utf8' : lower, enumerable: true, writable: true, configurable: true })
  internals.set(this, { text: label === undefined ? undefined : new TextDecoder(label), pending: new Uint8Array(0) })
} as unknown as StringDecoderConstructor

function stateOf (decoder: object): DecoderInternals {
  const state = internals.get(decoder)
  if (state === undefined) throw Object.assign(new TypeError('Illegal invocation: not a StringDecoder'), { code: 'ERR_INVALID_THIS' })
  return state
}

StringDecoder.prototype.write = function write (this: StringDecoder, chunk: Uint8Array | string): string {
  const state = stateOf(this)
  const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
  if (state.text !== undefined) return state.text.decode(bytes, { stream: true })
  if (!this.encoding.startsWith('base64')) return decode(bytes, this.encoding) as string
  const joined = Buffer.concat([state.pending, bytes])
  const whole = joined.length - (joined.length % 3)
  state.pending = joined.subarray(whole)
  return decode(joined.subarray(0, whole), this.encoding) as string
}

StringDecoder.prototype.end = function end (this: StringDecoder, chunk?: Uint8Array | string): string {
  const state = stateOf(this)
  const head = chunk === undefined ? '' : this.write(chunk)
  if (state.text !== undefined) return head + state.text.decode()
  const tail = state.pending.length === 0 ? '' : decode(state.pending, this.encoding) as string
  state.pending = new Uint8Array(0)
  return head + tail
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/string-decoder.js'

export default nodeModule('string_decoder', { StringDecoder })
