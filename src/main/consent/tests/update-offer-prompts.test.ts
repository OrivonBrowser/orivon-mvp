import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateOffer } from '../../install/app-updates.js'

// The plumbing only: the right spec reaches the panel, the right button maps to the answer, and a tab
// that left answers nothing. The words are update-available-render.test.ts's job.

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))
const specOf = (call = 0): Record<string, unknown> | undefined => askQuestion.mock.calls[call]?.[1] as Record<string, unknown> | undefined

const { createUpdatePrompts } = await import('../update-offer-prompts.js')

const ORIGIN = 'https://app.example'
const OFFER: UpdateOffer = { origin: ORIGIN, fromCid: 'a', toCid: 'b', fromVersion: '1.0.0', toVersion: '1.0.1', claimedName: 'App', level: 3, verified: true, reasons: [], newDomain: 'app.example' }

function caller (on: () => boolean): { stillOn: (origin: string) => boolean, contents: () => undefined, window: () => undefined, hold: () => () => void } {
  return { stillOn: (origin) => origin === ORIGIN && on(), contents: () => undefined, window: () => undefined, hold: () => () => {} }
}

beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

describe('the verified question', () => {
  it('answers yes for the first button, with the tick', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: true })
    expect(await createUpdatePrompts().verified(OFFER)).toEqual({ yes: true, quiet: true })
    expect(specOf()).toMatchObject({ kind: 'consent', buttons: ['Yes', 'Not now'], cancelId: 1, guarded: [0], checkboxLabel: 'Don\'t ask again for this version' })
  })

  it('answers no for Not now and for a way out, which cancels on Not now', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await createUpdatePrompts().verified(OFFER)).toEqual({ yes: false, quiet: false })
  })

  it('answers null, asking nothing, for a tab already off the origin', async () => {
    expect(await createUpdatePrompts().verified(OFFER, caller(() => false))).toBeNull()
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('answers null when the tab left while the question was open', async () => {
    let on = true
    askQuestion.mockImplementationOnce(async () => { on = false; return { response: 0, checkboxChecked: false } })
    expect(await createUpdatePrompts().verified(OFFER, caller(() => on))).toBeNull()
  })
})

describe('the notice', () => {
  it('is a notice with one OK button and the tick', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: true })
    expect(await createUpdatePrompts().notice({ ...OFFER, verified: false, reasons: ['no-provider'] })).toEqual({ quiet: true })
    expect(specOf()).toMatchObject({ kind: 'notice', buttons: ['OK'], cancelId: 0 })
  })
})

describe('the Trust & Force confirmation', () => {
  it('is a warned consent that cancels on Cancel, and is true only for the first button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await createUpdatePrompts().confirmForce({ ...OFFER, verified: false }, ['x'])).toBe(true)
    expect(specOf()).toMatchObject({ kind: 'consent', warning: true, buttons: ['Switch anyway', 'Cancel'], cancelId: 1, guarded: [0] })
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await createUpdatePrompts().confirmForce({ ...OFFER, verified: false }, [])).toBe(false)
  })
})

describe('the failure notice', () => {
  it('shows the reason', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await createUpdatePrompts().failed(OFFER, 'it broke')
    expect(specOf()).toMatchObject({ kind: 'notice', message: expect.stringContaining('it broke') })
  })
})
