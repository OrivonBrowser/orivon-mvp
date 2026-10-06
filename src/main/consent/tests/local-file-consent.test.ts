import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))
const specOf = (call = 0): Record<string, unknown> => askQuestion.mock.calls[call]?.[1] as Record<string, unknown>

const { createLocalFileConsentPrompt, displayPathOf, elideMiddle, LOCAL_FILE_CONSENT_TITLE } = await import('../local-file-consent.js')
const { normaliseSpec } = await import('../../shell/question/question-spec.js')

const KEY = 'file:///home/u/projects/notes/app.html'

describe('elideMiddle', () => {
  it('leaves a short path alone and cuts the middle of a long one, keeping both ends', () => {
    expect(elideMiddle('/home/u/a.html', 40)).toBe('/home/u/a.html')
    const cut = elideMiddle(`/home/u/${'deep/'.repeat(30)}app.html`, 40)
    expect(cut).toHaveLength(40)
    expect(cut.startsWith('/home/u/')).toBe(true)
    expect(cut.endsWith('app.html')).toBe(true)
    expect(cut).toContain('...')
  })
})

describe('displayPathOf', () => {
  it('reads the path of a key, decoded', () => {
    expect(displayPathOf('file:///home/u/a%20b.html', 'linux')).toBe('/home/u/a b.html')
    expect(displayPathOf('file:///C:/Users/u/a.html', 'win32')).toBe('C:\\Users\\u\\a.html')
  })
})

describe('createLocalFileConsentPrompt', () => {
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('asks in the warning style, with the path, the risk and the capabilities, and two buttons the second of which needs two presses', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const allowed = await createLocalFileConsentPrompt()(KEY, manifestWith({ fs: {} }), ['fs'], [])
    expect(allowed).toBe(true)

    const spec = specOf()
    expect(spec).toMatchObject({ kind: 'consent', warning: true, title: LOCAL_FILE_CONSENT_TITLE, buttons: ["Don't allow", 'Double-click to allow'], cancelId: 0, doublePress: [1], focus: 'dialog' })
    expect(LOCAL_FILE_CONSENT_TITLE).toBe('Let a file on this computer use Orivon permissions?')
    const text = `${String(spec['message'])}\n${String(spec['detail'])}`
    expect(text).toContain('Orivon cannot check files on your computer: no Web3 Score, no pinned copy.')
    expect(text).toContain('Whoever can change this file can change what it does and use what you allow here.')
    expect(text).toContain('Permissions and saved data belong to this location: a different file saved here later gets them.')
    expect(text).toContain('What the page stored before starts afresh.')
    expect(String(spec['detail'])).toContain('/home/u/projects/notes/app.html')
    expect(spec['origin']).toBe('/home/u/projects/notes/app.html')
    expect(normaliseSpec(spec as never).guarded).toEqual([1])
  })

  it('answers no for the first button, for a way out and for a tab that moved on', async () => {
    askQuestion.mockResolvedValue({ response: 0, checkboxChecked: false })
    expect(await createLocalFileConsentPrompt()(KEY, manifestWith({ fs: {} }), ['fs'], [])).toBe(false)
    const caller = { stillOn: () => false } as never
    expect(await createLocalFileConsentPrompt()(KEY, manifestWith({ fs: {} }), ['fs'], [], caller)).toBe(false)
    expect(askQuestion).toHaveBeenCalledTimes(1)
  })

  it('marks what is already allowed, and puts the path last, never as a second headline', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await createLocalFileConsentPrompt()(KEY, manifestWith({ fs: {}, id: {} } as never), ['fs', 'id'], ['fs'])
    const detail = String(specOf()['detail'])
    expect(detail).toContain('[Already allowed]')
    expect(detail.trimEnd().endsWith('/home/u/projects/notes/app.html')).toBe(true)
  })
})
