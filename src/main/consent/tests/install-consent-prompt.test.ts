import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// createInstallConsentPrompt asks through askQuestion, replaced first, same reasoning as request-grant-prompt.test.ts's
// own header. This suite confirms the plumbing (the right spec reaches the panel, the right button and switches map to
// the capabilities answered, the style tracks `warning`) -- WORDING is install-consent-panel.test.ts's own job.

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))
const specOf = (call = 0): Record<string, unknown> | undefined => askQuestion.mock.calls[call]?.[1] as Record<string, unknown> | undefined

const { createInstallConsentPrompt } = await import('../install-consent-prompt.js')
const { normaliseSpec, viewOf } = await import('../../shell/question/question-spec.js')

const ORIGIN = 'https://app.example'
const GRANT_ALL = { response: 0, checkboxChecked: false, clicked: true }
const closeWith = (chosen?: string[]): Record<string, unknown> => ({ response: 1, checkboxChecked: false, clicked: true, ...(chosen === undefined ? {} : { chosen }) })
const TWO = manifestWith({ fs: {}, net: { https: { connect: ['a.example:443'] } } })

describe('createInstallConsentPrompt', () => {
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('answers every row on Grant all', async () => {
    askQuestion.mockResolvedValueOnce(GRANT_ALL)
    expect(await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])).toEqual(['fs', 'https.connect'])
  })

  it('answers the rows switched on at Close, and nothing when none is', async () => {
    askQuestion.mockResolvedValueOnce(closeWith(['https.connect']))
    expect(await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])).toEqual(['https.connect'])
    askQuestion.mockResolvedValueOnce(closeWith([]))
    expect(await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])).toEqual([])
    askQuestion.mockResolvedValueOnce(closeWith())
    expect(await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])).toEqual([])
  })

  it('never answers a capability it did not offer, even when the panel names one', async () => {
    askQuestion.mockResolvedValueOnce(closeWith(['id', 'fs']))
    expect(await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])).toEqual(['fs'])
  })

  it('answers null for Escape, a closed tab or a navigation, which answer with Close\'s index without a press', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])).toBeNull()
  })

  it('asks one row per capability, off, with the grant icon of the capability, and the together line for an all-or-nothing app', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, TWO, ['fs', 'https.connect'])
    expect(specOf()).toMatchObject({
      choices: [{ id: 'fs', icon: 'fs' }, { id: 'https.connect', icon: 'https.connect' }],
      choicesNote: 'This app asked for these together; turning one off may break it.'
    })
    expect((specOf()?.['choices'] as Array<{ on?: boolean }>).some((choice) => choice.on === true)).toBe(false)
  })

  it('has no together line for an app that asked for its capabilities one by one', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, { ...TWO, consentGranularity: 'per-capability' }, ['fs', 'https.connect'])
    expect(specOf()).not.toHaveProperty('choicesNote')
  })

  it('hands the panel a spec whose view names the origin once, while the spec still names it for a native box', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'])

    const spec = normaliseSpec(specOf() as never)
    const view = viewOf('id', spec)
    const panel = [view.origin, view.title, view.message, view.detail].filter((part) => part !== undefined).join('\n')
    expect(panel.split(ORIGIN)).toHaveLength(2)
    expect(view.origin).toBe(ORIGIN)
    expect(`${spec.title ?? ''}\n${spec.detail ?? ''}`).toContain(ORIGIN)
  })

  it('puts Grant all first and Close last as the way out, and guards both buttons -- dismissing must never grant and a stray key must never decide', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'])
    expect(specOf()).toMatchObject({ cancelId: 1, guarded: [0, 1], kind: 'consent', buttons: ['Grant all', 'Close'], focus: 'dialog' })
  })

  it('draws the warning style when any declared capability is unlimited, the plain style otherwise', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['a.example:443'] } } }), ['https.connect'])
    expect(specOf()).toMatchObject({ warning: false })

    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['*:*'] } } }), ['https.connect'])
    expect(specOf(1)).toMatchObject({ warning: true, choices: [{ warning: true }] })
  })

  it('ADR-0037: an injected levelOverrideFor returning 4 for this origin drops the warning style and the warning mark', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt((origin) => origin === ORIGIN ? 4 : undefined)(ORIGIN, manifestWith({ net: { https: { connect: ['*:*'] } } }), ['https.connect'])
    expect(specOf()).toMatchObject({ warning: false })
    expect(JSON.stringify(specOf()?.['choices'])).not.toContain('⚠')
  })

  it('extensions disclosure: with no extensionsOnSite injected, defaults to naming none', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'])
    expect(specOf()).toMatchObject({ detail: expect.not.stringContaining('Extensions that can also act on this site') })
  })

  it('extensions disclosure: an injected extensionsOnSite is fetched for the origin and rendered into detail', async () => {
    askQuestion.mockResolvedValueOnce(closeWith([]))
    const extensionsOnSite = vi.fn(async (origin: string) => origin === ORIGIN ? ['Ad Blocker', 'Password Manager'] : [])
    await createInstallConsentPrompt(undefined, extensionsOnSite)(ORIGIN, manifestWith({ fs: {} }), ['fs'])
    expect(extensionsOnSite).toHaveBeenCalledWith(ORIGIN)
    expect(specOf()).toMatchObject({ detail: expect.stringContaining('Extensions that can also act on this site: Ad Blocker, Password Manager.') })
  })

  it('never asks when the caller has already left the origin', async () => {
    const caller = { window: () => undefined, stillOn: () => false }
    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], caller)).toBeNull()
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('asks in the panel of the calling tab and holds that tab until the answer', async () => {
    const tab = { id: 'the-tab' }
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    askQuestion.mockResolvedValueOnce(GRANT_ALL)
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab }

    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], caller)).toEqual(['fs'])
    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: tab })
    expect(holdNavigation).toHaveBeenCalledWith(tab)
    expect(release).toHaveBeenCalledOnce()
  })

  it('holds nothing for a caller whose page keeps running, such as a first visit to an app', async () => {
    const tab = { id: 'the-tab' }
    askQuestion.mockResolvedValueOnce(GRANT_ALL)
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab, unheld: true }

    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], caller)).toEqual(['fs'])
    expect(holdNavigation).not.toHaveBeenCalled()
    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: tab })
  })

  it('withdraws the question when the caller\'s signal aborts', async () => {
    const gone = new AbortController()
    askQuestion.mockImplementationOnce(async (_target, _spec, options) => {
      gone.abort()
      expect((options as { signal?: AbortSignal }).signal?.aborted).toBe(true)
      return { response: 1, checkboxChecked: false }
    })
    const caller = { window: () => undefined, stillOn: () => true, signal: gone.signal }

    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], caller)).toBeNull()
  })

  it('adds the first-prompt line above the buttons on the first question of a profile and never again, leaving the buttons and rows as they are', async () => {
    const { FirstPromptNote, FIRST_PROMPT_LINE } = await import('../first-prompt-note.js')
    const note = new FirstPromptNote(null)
    askQuestion.mockResolvedValue(GRANT_ALL)
    const prompt = createInstallConsentPrompt(() => undefined, async () => [], () => note.take())

    await prompt(ORIGIN, TWO, ['fs', 'https.connect'])
    await prompt(ORIGIN, TWO, ['fs', 'https.connect'])

    const first = specOf(0) as { detail: string }
    const second = specOf(1) as { detail: string }
    expect(first.detail).toContain(FIRST_PROMPT_LINE)
    expect(first.detail.split('\n').at(-1)).toBe(ORIGIN)
    expect(second.detail).not.toContain(FIRST_PROMPT_LINE)
    expect(first.detail.replace(`${FIRST_PROMPT_LINE}\n`, '')).toBe(second.detail)
    const sameOf = ({ buttons, cancelId, guarded, focus, choices, choicesNote }: Record<string, unknown>): unknown => ({ buttons, cancelId, guarded, focus, choices, choicesNote })
    expect(sameOf(specOf(0) as Record<string, unknown>)).toEqual(sameOf(specOf(1) as Record<string, unknown>))
    expect(specOf(0)).toMatchObject({ buttons: ['Grant all', 'Close'], cancelId: 1, guarded: [0, 1], focus: 'dialog' })
  })
})
