import { describe, expect, it } from 'vitest'
import { pathSegments } from '../path-segments.js'

describe('pathSegments', () => {
  it('splits and decodes', () => {
    expect(pathSegments('/')).toEqual([])
    expect(pathSegments('/a/b%2Ec')).toEqual(['a', 'b.c'])
    expect(pathSegments('/a/')).toEqual(['a'])
  })

  it('refuses anything that could leave the root or name nothing', () => {
    for (const p of ['a', '/../x', '/a/../b', '/./a', '/a//b', '/a%2Fb', '/a%00', '/%E0%A4%A']) {
      expect(pathSegments(p)).toBeUndefined()
    }
  })
})
