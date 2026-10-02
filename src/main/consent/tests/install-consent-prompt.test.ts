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

  it('hands the panel a spec whose view names the origin once, while the spec still names it for a native box', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    const spec = normaliseSpec(specOf() as never)
    const view = viewOf('id', spec)
    const panel = [view.origin, view.title, view.message, view.detail].filter((part) => part !== undefined).join('\n')
    expect(panel.split(ORIGIN)).toHaveLength(2)
    expect(view.origin).toBe(ORIGIN)
    expect(`${spec.title ?? ''}\n${spec.detail ?? ''}`).toContain(ORIGIN)
  })

  it('resolves false when the user picks the second (Deny) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const consent = createInstallConsentPrompt()

    const result = await consent(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(result).toBe(false)
  })

  it('cancels on the Deny button, and the Allow button is guarded -- dismissing the question must never grant', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(specOf()).toMatchObject({
      cancelId: 1,
      guarded: [0],
      kind: 'consent',
      buttons: ['Allow', 'Deny']
    })
  })

  it('draws the warning style when any declared capability is unlimited, the plain style otherwise', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['a.example:443'] } } }), ['https.connect'], [])
    expect(specOf()).toMatchObject({ warning: false })

    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await createInstallConsentPrompt()(ORIGIN, manifestWith({ net: { https: { connect: ['*:*'] } } }), ['https.connect'], [])
    expect(specOf(1)).toMatchObject({ warning: true })
  })

  it('passes the rendered title/message/detail straight through, not a second copy of the words', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ fs: {} })

    await createInstallConsentPrompt()(ORIGIN, manifest, ['fs'], [])

    expect(specOf()).toMatchObject({
      title: ORIGIN,
      message: 'This app wants to:',
      detail: expect.stringContaining('Store files in a private folder')
    })
  })

  it('ADR-0037: an injected levelOverrideFor returning 4 for this origin drops the warning style and the ⚠ text', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    await createInstallConsentPrompt((origin) => origin === ORIGIN ? 4 : undefined)(ORIGIN, manifest, ['https.connect'], [])

    expect(specOf()).toMatchObject({
      warning: false,
      detail: expect.not.stringContaining('⚠')
    })
  })

  it('with no levelOverrideFor injected, defaults to never overriding -- an unlimited grant still warns', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    await createInstallConsentPrompt()(ORIGIN, manifest, ['https.connect'], [])

    expect(specOf()).toMatchObject({ warning: true })
  })

  it('extensions disclosure: with no extensionsOnSite injected, defaults to naming none', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createInstallConsentPrompt()(ORIGIN, manifestWith({ fs: {} }), ['fs'], [])

    expect(specOf()).toMatchObject({
      detail: expect.not.stringContaining('Extensions that can also act on this site')
    })
  })

  it('extensions disclosure: an injected extensionsOnSite is fetched for the origin and rendered into detail', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
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

    expect(result).toBe(false)
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
})
