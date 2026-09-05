import { describe, expect, it } from 'vitest'
import {
  isCreditMessage, isWriteAbortMessage, isWriteEndMessage, isWriteMessage, parseRendererToBrokerMessage
} from './port-messages.js'

const HANDLE = 'handle-1'

describe('isCreditMessage', () => {
  it('accepts a well-formed credit message', () => {
    expect(isCreditMessage({ kind: 'credit', handleId: HANDLE, bytesConsumed: 10 })).toBe(true)
  })

  it.each([
    ['non-object', null],
    ['a plain string', 'credit'],
    ['wrong kind', { kind: 'write', handleId: HANDLE, bytesConsumed: 10 }],
    ['missing handleId', { kind: 'credit', bytesConsumed: 10 }],
    ['non-string handleId', { kind: 'credit', handleId: 1, bytesConsumed: 10 }],
    ['non-number bytesConsumed', { kind: 'credit', handleId: HANDLE, bytesConsumed: '10' }],
    ['NaN bytesConsumed', { kind: 'credit', handleId: HANDLE, bytesConsumed: Number.NaN }],
    ['Infinity bytesConsumed', { kind: 'credit', handleId: HANDLE, bytesConsumed: Number.POSITIVE_INFINITY }],
    ['negative bytesConsumed', { kind: 'credit', handleId: HANDLE, bytesConsumed: -1 }]
  ])('rejects %s', (_name, value) => {
    expect(isCreditMessage(value)).toBe(false)
  })
})

describe('isWriteMessage', () => {
  it('accepts a well-formed write message', () => {
    expect(isWriteMessage({ kind: 'write', handleId: HANDLE, chunk: new Uint8Array([1, 2]) })).toBe(true)
  })

  it.each([
    ['non-object', undefined],
    ['wrong kind', { kind: 'credit', handleId: HANDLE, chunk: new Uint8Array() }],
    ['missing handleId', { kind: 'write', chunk: new Uint8Array() }],
    ['non-string handleId', { kind: 'write', handleId: 1, chunk: new Uint8Array() }],
    ['chunk not a Uint8Array (plain array)', { kind: 'write', handleId: HANDLE, chunk: [1, 2] }],
    ['chunk not a Uint8Array (raw ArrayBuffer)', { kind: 'write', handleId: HANDLE, chunk: new ArrayBuffer(4) }],
    ['missing chunk', { kind: 'write', handleId: HANDLE }]
  ])('rejects %s', (_name, value) => {
    expect(isWriteMessage(value)).toBe(false)
  })
})

describe('isWriteEndMessage', () => {
  it('accepts a well-formed write-end message', () => {
    expect(isWriteEndMessage({ kind: 'write-end', handleId: HANDLE })).toBe(true)
  })

  it.each([
    ['wrong kind', { kind: 'write-abort', handleId: HANDLE }],
    ['missing handleId', { kind: 'write-end' }],
    ['non-object', 42]
  ])('rejects %s', (_name, value) => {
    expect(isWriteEndMessage(value)).toBe(false)
  })
})

describe('isWriteAbortMessage', () => {
  it('accepts a well-formed write-abort message', () => {
    expect(isWriteAbortMessage({ kind: 'write-abort', handleId: HANDLE })).toBe(true)
  })

  it.each([
    ['wrong kind', { kind: 'write-end', handleId: HANDLE }],
    ['missing handleId', { kind: 'write-abort' }]
  ])('rejects %s', (_name, value) => {
    expect(isWriteAbortMessage(value)).toBe(false)
  })
})

describe('parseRendererToBrokerMessage', () => {
  it('dispatches each recognised kind to its own validated shape', () => {
    expect(parseRendererToBrokerMessage({ kind: 'credit', handleId: HANDLE, bytesConsumed: 1 }))
      .toEqual({ kind: 'credit', handleId: HANDLE, bytesConsumed: 1 })
    expect(parseRendererToBrokerMessage({ kind: 'write', handleId: HANDLE, chunk: new Uint8Array([1]) }))
      .toEqual({ kind: 'write', handleId: HANDLE, chunk: new Uint8Array([1]) })
    expect(parseRendererToBrokerMessage({ kind: 'write-end', handleId: HANDLE }))
      .toEqual({ kind: 'write-end', handleId: HANDLE })
    expect(parseRendererToBrokerMessage({ kind: 'write-abort', handleId: HANDLE }))
      .toEqual({ kind: 'write-abort', handleId: HANDLE })
  })

  it.each([
    ['null', null],
    ['a bare string', 'write'],
    ['an unrecognised kind', { kind: 'nonsense', handleId: HANDLE }],
    ['a recognised kind with a malformed body', { kind: 'write', handleId: HANDLE, chunk: 'not bytes' }],
    ['no kind at all', { handleId: HANDLE }]
  ])('returns undefined for %s', (_name, value) => {
    expect(parseRendererToBrokerMessage(value)).toBeUndefined()
  })
})
