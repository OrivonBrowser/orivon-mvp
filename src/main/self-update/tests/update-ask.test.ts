import { describe, expect, it } from 'vitest'
import { normaliseSpec } from '../../shell/question/question-spec.js'
import { readUpdateChoice, updateQuestion } from '../update-ask.js'

const CAN = { ok: true } as const
const CANNOT = { ok: false } as const
const CANNOT_WHY = { ok: false, why: 'This copy runs from its source folder, so it cannot replace itself.' } as const
const GITHUB = 'Download from GitHub'
const ENS = 'Download from latest.orivonstack.eth'

describe('the update question', () => {
  it('names the new version and the running one, offers the release page, the newest-release name and a way out, and asks nothing else', () => {
    const spec = updateQuestion('0.0.12', '0.0.11', CANNOT)
    expect(spec).toMatchObject({ kind: 'notice', title: 'Orivon 0.0.12 is available', message: 'You have 0.0.11.', buttons: [GITHUB, ENS, 'Not now'], cancelId: 2, guarded: [0, 1], focus: 'dialog' })
    expect(spec.detail).toBeUndefined()
  })

  it('takes no key press and guards every button that does something, since it appears while the person may be typing', () => {
    for (const installable of [CANNOT, CANNOT_WHY, CAN]) {
      const spec = updateQuestion('0.0.12', '0.0.11', installable)
      const doing = spec.buttons.map((_, index) => index).filter((index) => index !== spec.cancelId)
      expect(spec.focus).toBe('dialog')
      expect(spec.guarded).toEqual(doing)
      expect(spec.guarded).not.toContain(spec.cancelId)
    }
  })

  it('keeps both download buttons guarded after the panel\'s cleaning, so a stray click opens neither page', () => {
    expect(normaliseSpec(updateQuestion('0.0.12', '0.0.11', CANNOT)).guarded).toEqual([0, 1])
    expect(normaliseSpec(updateQuestion('0.0.12', '0.0.11', CAN)).guarded).toEqual([0, 1, 2])
  })

  it('says why this copy cannot install when a reason is given, and offers the install button only when it can', () => {
    expect(updateQuestion('1.2.0', '1.0.0', CANNOT_WHY)).toMatchObject({ buttons: [GITHUB, ENS, 'Not now'], cancelId: 2, detail: CANNOT_WHY.why })
    expect(updateQuestion('1.2.0', '1.0.0', CAN)).toMatchObject({ buttons: ['Install update', GITHUB, ENS, 'Not now'], cancelId: 3, guarded: [0, 1, 2] })
  })

  it('reads the button the person pressed, and a way out as later', () => {
    expect(readUpdateChoice(0, CANNOT)).toBe('github')
    expect(readUpdateChoice(1, CANNOT)).toBe('ens')
    expect(readUpdateChoice(2, CANNOT)).toBe('later')
    expect(readUpdateChoice(0, CAN)).toBe('install')
    expect(readUpdateChoice(1, CAN)).toBe('github')
    expect(readUpdateChoice(2, CAN)).toBe('ens')
    expect(readUpdateChoice(3, CAN)).toBe('later')
    expect(readUpdateChoice(-1, CANNOT)).toBe('later')
  })

  it('survives the panel\'s cleaning with its words and buttons intact', () => {
    const cleaned = normaliseSpec(updateQuestion('0.0.12', '0.0.11', CANNOT))
    expect(cleaned.title).toBe('Orivon 0.0.12 is available')
    expect(cleaned.buttons).toEqual([GITHUB, ENS, 'Not now'])
    expect(cleaned.cancelId).toBe(2)
  })
})
