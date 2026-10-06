import { describe, expect, it } from 'vitest'
import { plainPath } from '../plain-path.js'

describe('plainPath', () => {
  it('leaves an ordinary path alone', () => {
    expect(plainPath('/home/a/My notes/index.html')).toBe('/home/a/My notes/index.html')
  })

  it('drops the right-to-left override that makes a name read as another extension', () => {
    expect(plainPath('/home/a/photo‮gpj.html')).toBe('/home/a/photogpj.html')
  })

  it('drops isolates, marks and control characters', () => {
    expect(plainPath('/a⁦b⁩‎c\u0007d\u0000')).toBe('/abcd')
  })
})
