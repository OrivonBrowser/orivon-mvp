import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { OrivonShimError } from '../../errors.js'
import http2, * as http2Namespace from '../http2.js'

const real = createRequire(import.meta.url)('node:http2') as { constants: Record<string, string | number> }

describe('http2', () => {
  it('carries Node\'s constants, the names http2-wrapper and undici destructure as they load', () => {
    expect(http2.constants).toEqual(real.constants)
    expect(http2Namespace.constants.HTTP2_HEADER_STATUS).toBe(':status')
    expect(http2.constants.HTTP2_METHOD_CONNECT).toBe('CONNECT')
    expect(http2.constants.NGHTTP2_NO_ERROR).toBe(0)
  })

  it('spreads like the real module: http2-wrapper does `...http2`', () => {
    const spread = { ...http2 }
    expect(spread.constants).toBe(http2.constants)
    expect(typeof spread.sensitiveHeaders).toBe('symbol')
  })

  it('refuses every function by name', () => {
    const module = http2 as unknown as Record<string, () => void>
    for (const name of ['connect', 'createServer', 'createSecureServer', 'getDefaultSettings']) {
      expect(() => module[name]!(), name).toThrow(OrivonShimError)
      expect(() => module[name]!(), name).toThrow(new RegExp(`http2\\.${name}`))
    }
    expect(() => http2Namespace.connect()).toThrow(/http2\.connect/)
  })
})
