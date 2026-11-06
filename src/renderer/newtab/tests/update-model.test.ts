import { describe, expect, it } from 'vitest'
import { readUpdate, updateLabel } from '../update-model.js'

describe('readUpdate', () => {
  it('reads the two versions main answers', () => {
    expect(readUpdate({ latest: '0.0.12', current: '0.0.11' })).toEqual({ latest: '0.0.12', current: '0.0.11' })
    expect(readUpdate({ latest: '1.2.3-rc.1', current: '1.2.2' })).toEqual({ latest: '1.2.3-rc.1', current: '1.2.2' })
  })

  it.each([
    undefined, null, 'update', 4, {}, { latest: '0.0.12' }, { current: '0.0.11' },
    { latest: 12, current: '0.0.11' },
    { latest: 'v0.0.12', current: '0.0.11' },
    { latest: '0.0.12', current: '' },
    { latest: '<b>1.0.0</b>', current: '0.0.11' },
    { latest: '0.0.12', current: '0.0.11 now' }
  ])('shows no button for an answer that is not two versions: %j', (answer) => {
    expect(readUpdate(answer)).toBeNull()
  })
})

describe('updateLabel', () => {
  it('names the release and the running version', () => {
    expect(updateLabel({ latest: '0.0.12', current: '0.0.11' })).toBe('Orivon 0.0.12 is available. You have 0.0.11.')
  })
})
