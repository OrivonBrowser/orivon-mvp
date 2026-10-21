import { describe, expect, it } from 'vitest'
import { privateWords } from '../private/words.js'

describe('what the Private page says', () => {
  it('says an ordinary private window keeps nothing past its last window, and offers another ordinary one', () => {
    const words = privateWords(undefined)
    expect(words.title).toBe('You are in a private window')
    expect(words.lead).toBe('It starts empty, and everything it holds is deleted when you close its last window.')
    expect(words.hidesNot[0]).toContain('Your network address')
    expect(words.another).toBe('Open another private window')
  })

  it('says a window with Nym sends every page and Orivon\'s own requests through it, keeps nothing, and offers another like it', () => {
    const words = privateWords('nym')
    expect(words.title).toBe('You are in a private window with Nym')
    expect(words.lead).toContain('Every page and everything Orivon sends for itself goes through Nym')
    expect(words.lead).toContain('deleted when you close its last window')
    expect(words.hidesNot[0]).toContain('Nym\'s gateways')
    expect(words.another).toBe('Open another private window with Nym')
  })

  it('keeps the same promises about what is kept and what is not, whichever window it is', () => {
    expect(privateWords('nym').keeps).toEqual(privateWords(undefined).keeps)
    expect(privateWords('nym').keepsNot).toEqual(privateWords(undefined).keepsNot)
  })
})
