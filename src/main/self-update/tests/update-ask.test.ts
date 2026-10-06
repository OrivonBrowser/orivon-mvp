import { describe, expect, it } from 'vitest'
import { failureQuestion, readUpdateChoice, updateQuestion } from '../update-ask.js'

const CAN = { ok: true } as const
const CANNOT = { ok: false, why: 'This copy runs from its source folder, so it cannot replace itself.' } as const

describe('the update question', () => {
  it('names the version and the one the person has, with three buttons when this copy can install', () => {
    const spec = updateQuestion('1.2.0', '1.0.0', CAN)
    expect(spec).toMatchObject({ kind: 'notice', title: 'Orivon 1.2.0 is available', message: 'You have 1.0.0.', buttons: ['Install update', 'Download from GitHub', 'Not now'], cancelId: 2, guarded: [0], focus: 'dialog' })
    expect(spec.detail).toBeUndefined()
  })

  it('offers the release page alone, and says why, when this copy cannot install', () => {
    const spec = updateQuestion('1.2.0', '1.0.0', CANNOT)
    expect(spec).toMatchObject({ buttons: ['Download from GitHub', 'Not now'], cancelId: 1, detail: CANNOT.why, guarded: [0], focus: 'dialog' })
  })

  it('reads the button the person pressed, and a way out as later', () => {
    expect(readUpdateChoice(0, CAN)).toBe('install')
    expect(readUpdateChoice(1, CAN)).toBe('github')
    expect(readUpdateChoice(2, CAN)).toBe('later')
    expect(readUpdateChoice(0, CANNOT)).toBe('github')
    expect(readUpdateChoice(1, CANNOT)).toBe('later')
  })

  it('says why an install failed, and offers the release page', () => {
    expect(failureQuestion('You did not allow the installation.')).toMatchObject({
      title: 'Orivon could not install the update',
      detail: 'You did not allow the installation.',
      buttons: ['Download from GitHub', 'Close'],
      cancelId: 1
    })
  })
})
