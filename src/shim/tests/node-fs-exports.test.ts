// A bundler's CommonJS interop builds `require('fs')` from this module's
// NAMED exports, never from properties of its default export -- so a member
// that lives only on the default export reads as `undefined` to every
// bundled CommonJS caller, even though the default export itself is right.
import { describe, expect, it } from 'vitest'
import * as fs from '../node-fs.js'

describe("node-fs: the members a bundled require('fs') reads", () => {
  it('exposes constants as a named export, as data', () => {
    const named = fs as unknown as { constants?: { F_OK?: number, W_OK?: number } }
    expect(named.constants?.F_OK).toBe(0)
    expect(named.constants?.W_OK).toBe(2)
  })

  it('exposes the same constants object on the named and default exports', () => {
    const named = fs as unknown as { constants?: unknown, default: { constants?: unknown } }
    expect(named.constants).toBe(named.default.constants)
  })

  it('exposes promises as a named export', () => {
    expect(typeof fs.promises.readFile).toBe('function')
  })
})
