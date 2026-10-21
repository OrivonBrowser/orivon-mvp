import { describe, expect, it, vi } from 'vitest'
import { flavourOfCommandLine, offerFirstRunFlavour } from '../first-run-flavour.js'

const PACKAGED = ['/opt/Orivon/orivon']

describe('flavourOfCommandLine', () => {
  it('reads the flavour of the first link that carries a valid one', () => {
    expect(flavourOfCommandLine([...PACKAGED, '--', 'orivon:open?u=vitalik.eth&flavour=freetube'], true)).toBe('freetube')
    expect(flavourOfCommandLine([...PACKAGED, '--', 'orivon:open?u=a.eth', 'orivon:open?u=b.eth&flavour=element'], true)).toBe('element')
    expect(flavourOfCommandLine(['/usr/lib/electron', '.', 'orivon://open?u=a.eth&flavour=ab'], false)).toBe('ab')
  })

  it('finds none on a command line without a link, or with a link that is refused or carries a bad or repeated id', () => {
    expect(flavourOfCommandLine([...PACKAGED], true)).toBeUndefined()
    expect(flavourOfCommandLine([...PACKAGED, 'https://example.com/?flavour=freetube'], true)).toBeUndefined()
    expect(flavourOfCommandLine([...PACKAGED, '--', 'orivon:open?u=https://evil.example&flavour=freetube'], true)).toBeUndefined()
    expect(flavourOfCommandLine([...PACKAGED, '--', 'orivon:open?u=a.eth&flavour=Free-Tube'], true)).toBeUndefined()
    expect(flavourOfCommandLine([...PACKAGED, '--', 'orivon:open?u=a.eth&flavour=freetube&flavour=element'], true)).toBeUndefined()
  })

  it('never reads a switch as a link', () => {
    expect(flavourOfCommandLine([...PACKAGED, '--orivon-flavour=freetube', 'orivon:open?flavour=freetube'], true)).toBeUndefined()
  })
})

describe('offerFirstRunFlavour', () => {
  it('hands the hint an id of the right shape', () => {
    const hint = vi.fn()
    offerFirstRunFlavour('freetube', hint)
    expect(hint).toHaveBeenCalledExactlyOnceWith('freetube')
  })

  it('hands it nothing else', () => {
    const hint = vi.fn()
    for (const id of [undefined, '', 'a', 'Free', 'free-tube', 'free.tube', 'https://evil.example', '../x', 'a'.repeat(25), 'ab\n', ' ab', 5, null, {}] as unknown[]) {
      offerFirstRunFlavour(id as string | undefined, hint)
    }
    expect(hint).not.toHaveBeenCalled()
  })

  it('does nothing yet when no hint is given', () => {
    expect(() => { offerFirstRunFlavour('freetube') }).not.toThrow()
  })
})
