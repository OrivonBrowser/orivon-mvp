import { describe, expect, it } from 'vitest'
import { standardTexts } from '../licence-texts.js'

describe('standardTexts', () => {
  it('writes the text of a licence with the copyright holder in its copyright line', () => {
    const [mit] = standardTexts('MIT', 'Ada Lovelace') ?? []
    expect(mit?.id).toBe('MIT')
    expect(mit?.text).toContain('Copyright (c) Ada Lovelace\n')
    expect(mit?.text).toContain('Permission is hereby granted, free of charge')
    expect(standardTexts('ISC', 'Ada')?.[0]?.text).toContain('Permission to use, copy, modify, and/or distribute')
    expect(standardTexts('BSD-2-Clause', 'Ada')?.[0]?.text).not.toContain('Neither the name')
    expect(standardTexts('BSD-3-Clause', 'Ada')?.[0]?.text).toContain('Neither the name')
  })

  it('keeps a "$" in a holder\'s name as it is', () => {
    expect(standardTexts('MIT', 'Pay$& Co')?.[0]?.text).toContain('Copyright (c) Pay$& Co\n')
  })

  it('reproduces the first alternative of an OR it has a text for, and every term of an AND', () => {
    expect(standardTexts('Apache-2.0 OR MIT', 'Ada')?.map((entry) => entry.id)).toEqual(['MIT'])
    expect(standardTexts('(MIT OR Apache-2.0)', 'Ada')?.map((entry) => entry.id)).toEqual(['MIT'])
    expect(standardTexts('MIT AND ISC', 'Ada')?.map((entry) => entry.id)).toEqual(['MIT', 'ISC'])
    expect(standardTexts('mit', 'Ada')?.map((entry) => entry.id)).toEqual(['mit'])
  })

  it('has nothing for a licence it holds no text for, or for an AND with one such term', () => {
    expect(standardTexts('Apache-2.0', 'Ada')).toBeUndefined()
    expect(standardTexts('MIT AND Apache-2.0', 'Ada')).toBeUndefined()
    expect(standardTexts('GPL-2.0-only WITH Classpath-exception-2.0', 'Ada')).toBeUndefined()
    expect(standardTexts('', 'Ada')).toBeUndefined()
  })
})
