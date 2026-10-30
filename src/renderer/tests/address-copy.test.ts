import { describe, expect, it, vi } from 'vitest'
import { handleAddressCopy, MAX_COPIED_FIELD, wholeFieldText } from '../chrome/address-copy.js'

const ADDRESS = 'ipfs://explore.orivonstack.eth'

const field = (value: string, selectionStart: number | null, selectionEnd: number | null) => ({ value, selectionStart, selectionEnd })

function copy (value: string, start: number | null, end: number | null): { prevented: boolean, act: ReturnType<typeof vi.fn> } {
  let prevented = false
  const act = vi.fn(async () => true)
  handleAddressCopy(field(value, start, end), { preventDefault: () => { prevented = true } }, act)
  return { prevented, act }
}

describe('what a copy of the address field takes', () => {
  it('is the text when the selection covers all of it', () => {
    expect(wholeFieldText(field(ADDRESS, 0, ADDRESS.length))).toBe(ADDRESS)
  })

  it('is nothing for a caret, a part or a field with no selection', () => {
    expect(wholeFieldText(field(ADDRESS, 0, 4))).toBeUndefined()
    expect(wholeFieldText(field(ADDRESS, 1, ADDRESS.length))).toBeUndefined()
    expect(wholeFieldText(field(ADDRESS, 0, ADDRESS.length - 1))).toBeUndefined()
    expect(wholeFieldText(field(ADDRESS, 5, 5))).toBeUndefined()
    expect(wholeFieldText(field(ADDRESS, null, null))).toBeUndefined()
  })

  it('is nothing for an empty field, or a text longer than main takes', () => {
    expect(wholeFieldText(field('', 0, 0))).toBeUndefined()
    const long = 'x'.repeat(MAX_COPIED_FIELD + 1)
    expect(wholeFieldText(field(long, 0, long.length))).toBeUndefined()
    const edge = 'x'.repeat(MAX_COPIED_FIELD)
    expect(wholeFieldText(field(edge, 0, edge.length))).toBe(edge)
  })
})

describe('a copy in the address field', () => {
  it('stops the browser\'s copy and sends the whole address to main when all of it is selected', () => {
    const { prevented, act } = copy(ADDRESS, 0, ADDRESS.length)
    expect(prevented).toBe(true)
    expect(act).toHaveBeenCalledExactlyOnceWith('address.copy', { text: ADDRESS })
  })

  it('is left to the browser, and sends nothing, when only a part is selected', () => {
    const { prevented, act } = copy(ADDRESS, 7, ADDRESS.length)
    expect(prevented).toBe(false)
    expect(act).not.toHaveBeenCalled()
  })

  it('is left to the browser when nothing is selected', () => {
    const { prevented, act } = copy(ADDRESS, ADDRESS.length, ADDRESS.length)
    expect(prevented).toBe(false)
    expect(act).not.toHaveBeenCalled()
  })

  it('sends the field\'s own text, whatever the bar shows over it', () => {
    const full = 'https://www.example.com/'
    expect(copy(full, 0, full.length).act).toHaveBeenCalledWith('address.copy', { text: full })
  })
})
