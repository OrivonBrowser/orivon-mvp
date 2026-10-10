import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// createInstallConsentPrompt asks through askQuestion, replaced first, same
// reasoning as request-grant-prompt.test.ts's own header. This suite confirms
// the plumbing (the right spec reaches the panel, the right button maps to
// true/false, the style tracks `warning`) -- WORDING is
// grant-prompt-render.test.ts's own job.

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))
const specOf = (call = 0): Record<string, unknown> | undefined => askQuestion.mock.calls[call]?.[1] as Record<string, unknown> | undefined

const { createInstallConsentPrompt } = await import('../install-consent-prompt.js')
const { normaliseSpec, viewOf } = await import('../../shell/question/question-spec.js')

const ORIGIN = 'https://app.example'

describe('createInstallConsentPrompt', () => {
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('resolves true when the user picks the first (Allow) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const consent = createInstallConsentPrompt()

    const result = await consent(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(result).toBe(true)
  })

  it('resolves false for the pressed Deny, and dismissed for Escape, a closed tab or a navigation, which answer with the same index', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])).toBe(false)
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])).toBe('dismissed')
  })

  it('hands the panel a spec whose view names the origin once, while the spec still names it for a native box', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    const spec = normaliseSpec(specOf() as never)
    const view = viewOf('id', spec)
    const panel = [view.origin, view.title, view.message, view.detail].filter((part) => part !== undefined).join('\n')
    expect(panel.split(ORIGIN)).toHaveLength(2)
    expect(view.origin).toBe(ORIGIN)
    expect(`${spec.title ?? ''}\n${spec.detail ?? ''}`).toContain(ORIGIN)
  })

  it('resolves false when the user picks the second (Deny) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    const consent = createInstallConsentPrompt()

    const result = await consent(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(result).toBe(false)
  })

  it('cancels on the Deny button, and both buttons are guarded -- dismissing must never grant and a stray key must never persist a refusal', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })

    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(specOf()).toMatchObject({
      cancelId: 1,
      guarded: [0, 1],
      kind: 'consent',
      buttons: ['Allow', 'Deny']
    })
  })

  it('draws the warning style when any declared capability is unlimited, the plain style otherwise', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['a.example:443'] } } }), ['https.connect'], [])
    expect(specOf()).toMatchObject({ warning: false })

    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['*:*'] } } }), ['https.connect'], [])
    expect(specOf(1)).toMatchObject({ warning: true })
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    const manifest = manifestWith({ fs: {} })

    await createInstallConsentPrompt()(ORIGIN, manifest, ['fs'], [])

    expect(specOf()).toMatchObject({
      title: ORIGIN,
      message: 'This app wants to:',
      detail: expect.stringContaining('Store files in a private folder')
    })
  })

  it('ADR-0037: an injected levelOverrideFor returning 4 for this origin drops the warning style and the ⚠ text', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    await createInstallConsentPrompt((origin) => origin === ORIGIN ? 4 : undefined)(ORIGIN, manifest, ['https.connect'], [])

    expect(specOf()).toMatchObject({
      warning: false,
      detail: expect.not.stringContaining('⚠')
    })
  })

  it('with no levelOverrideFor injected, defaults to never overriding -- an unlimited grant still warns', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    await createInstallConsentPrompt()(ORIGIN, manifest, ['https.connect'], [])

    expect(specOf()).toMatchObject({ warning: true })
  })

  it('extensions disclosure: with no extensionsOnSite injected, defaults to naming none', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })

    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(specOf()).toMatchObject({
      detail: expect.not.stringContaining('Extensions that can also act on this site')
    })
  })

  it('extensions disclosure: an injected extensionsOnSite is fetched for the origin and rendered into detail', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false, clicked: true })
    const extensionsOnSite = vi.fn(async (origin: string) => origin === ORIGIN ? ['Ad Blocker', 'Password Manager'] : [])

    await createInstallConsentPrompt(undefined, extensionsOnSite)(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(extensionsOnSite).toHaveBeenCalledWith(ORIGIN)
    expect(specOf()).toMatchObject({
      detail: expect.stringContaining('Extensions that can also act on this site: Ad Blocker, Password Manager.')
    })
  })

  it('never asks when the caller has already left the origin', async () => {
    const caller = { window: () => undefined, stillOn: () => false }

    const result = await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [], caller)

    expect(result).toBe('dismissed')
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('asks in the panel of the calling tab and holds that tab until the answer', async () => {
    const tab = { id: 'the-tab' }
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab }

    const result = await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [], caller)

    expect(result).toBe(true)
    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: tab })
    expect(holdNavigation).toHaveBeenCalledWith(tab)
    expect(release).toHaveBeenCalledOnce()
  })

  it('holds nothing for a caller whose page keeps running, such as a first visit to an app', async () => {
    const tab = { id: 'the-tab' }
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab, unheld: true }

    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [], caller)).toBe(true)

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

    expect(await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [], caller)).toBe('dismissed')
  })
})
