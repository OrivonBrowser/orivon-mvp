import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'
import { stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'

// createGrantPrompt asks through askQuestion, which imports 'electron' at
// module scope, so it is replaced here. This suite confirms the plumbing (the
// right spec reaches the panel for the right tab, the right button maps to
// true/false, an abort withdraws the question, a manifest-read failure fails
// closed) -- WORDING is grant-prompt-render.test.ts's own job, unit-tested
// there against real Manifest values with no Electron import at all.

const askQuestion = vi.fn()
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))
const holdNavigation = vi.fn()
vi.mock('../../shell/navigation-hold.js', () => ({ holdNavigation }))

const { createGrantPrompt } = await import('../request-grant-prompt.js')

const specOf = (call = 0): unknown => askQuestion.mock.calls[call]?.[1]

const ORIGIN = 'https://app.example'

function brokerWithManifest (manifest: ReturnType<typeof manifestWith>): Broker {
  return stubBroker([], { manifest: async () => manifest })
}

describe('createGrantPrompt', () => {
  // askQuestion is one shared mock across every test in this file -- reset
  // its call log each time, or "not called" assertions below would see calls
  // left over from an earlier test.
  beforeEach(() => { askQuestion.mockReset(); holdNavigation.mockReset().mockReturnValue(() => {}) })

  it('resolves true when the user picks the first (Allow) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))

    const result = await consent(ORIGIN, 'fs', [])

    expect(result).toBe(true)
  })

  it('resolves false when the user picks the second (Deny) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))

    const result = await consent(ORIGIN, 'fs', [])

    expect(result).toBe(false)
  })

  it('shows the rendered content -- origin as title, the composed message and detail', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ net: { https: { connect: ['youtube.com:443'] } } })
    const consent = createGrantPrompt(brokerWithManifest(manifest))

    await consent(ORIGIN, 'https.connect', ['youtube.com:443'])

    expect(specOf()).toMatchObject({
      kind: 'consent',
      warning: false,
      title: ORIGIN,
      message: 'Connect to youtube.com',
      detail: expect.stringContaining(manifest.name)
    })
  })

  it('draws the question in the warning style for an unlimited declaration', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })
    const consent = createGrantPrompt(brokerWithManifest(manifest))

    await consent(ORIGIN, 'https.connect', ['*:*'])

    expect(specOf()).toMatchObject({ warning: true })
  })

  it('fetches the manifest itself rather than trusting a widened ConsentPrompt signature', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ fs: {} })
    const fetchManifest = vi.fn(async () => manifest)
    const consent = createGrantPrompt(stubBroker([], { manifest: fetchManifest }))

    await consent(ORIGIN, 'fs', [])

    expect(fetchManifest).toHaveBeenCalledWith(ORIGIN)
  })

  it('fails closed -- denies with no dialog shown -- when the manifest cannot be read back', async () => {
    const consent = createGrantPrompt(stubBroker([], { manifest: async () => { throw new Error('internal') } }))

    const result = await consent(ORIGIN, 'fs', [])

    expect(result).toBe(false)
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('ADR-0037: an injected levelOverrideFor returning 4 keeps the question out of the warning style for an unlimited declaration', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })
    const consent = createGrantPrompt(brokerWithManifest(manifest), (origin) => origin === ORIGIN ? 4 : undefined)

    await consent(ORIGIN, 'https.connect', ['*:*'])

    expect(specOf()).toMatchObject({ warning: false, message: 'Unlimited network access' })
  })

  it('extensions disclosure: defaults to naming no extensions, so every pre-existing call above is unaffected', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))

    await consent(ORIGIN, 'fs', [])

    expect(specOf()).toMatchObject({
      detail: expect.not.stringContaining('Extensions that can also act on this site')
    })
  })

  it('extensions disclosure: an injected extensionsOnSite is fetched for the origin and rendered into detail', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const extensionsOnSite = vi.fn(async (origin: string) => origin === ORIGIN ? ['Ad Blocker'] : [])
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })), undefined, extensionsOnSite)

    await consent(ORIGIN, 'fs', [])

    expect(extensionsOnSite).toHaveBeenCalledWith(ORIGIN)
    expect(specOf()).toMatchObject({
      detail: expect.stringContaining('Extensions that can also act on this site: Ad Blocker.')
    })
  })

  // Task: a dialog for a caller that has already left is never shown.
  it('never asks when the caller has already left the origin', async () => {
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))
    const caller = { window: () => undefined, stillOn: () => false }

    const result = await consent(ORIGIN, 'fs', [], caller)

    expect(result).toBe(false)
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('asks in the panel of the tab the caller names, holds that tab until the answer, and releases it after', async () => {
    const tab = { id: 'the-tab' }
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    let held = false
    askQuestion.mockImplementationOnce(async () => {
      held = holdNavigation.mock.calls.length === 1 && release.mock.calls.length === 0
      return { response: 0, checkboxChecked: false }
    })
    const caller = { window: () => undefined, stillOn: () => true, contents: () => tab }

    const result = await createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))(ORIGIN, 'fs', [], caller)

    expect(result).toBe(true)
    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: tab })
    expect(holdNavigation).toHaveBeenCalledWith(tab)
    expect(held).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the hold when the question fails', async () => {
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    askQuestion.mockRejectedValueOnce(new Error('no window'))
    const caller = { window: () => undefined, stillOn: () => true, contents: () => ({}) }

    await expect(createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))(ORIGIN, 'fs', [], caller)).rejects.toThrow('no window')

    expect(release).toHaveBeenCalledOnce()
  })

  it('hands the abandon signal to the question, so a call that gave up withdraws it', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const abandoned = new AbortController().signal
    const caller = { window: () => undefined, stillOn: () => true }

    await createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))(ORIGIN, 'fs', [], caller, abandoned)

    expect(askQuestion.mock.calls[0]?.[2]).toEqual({ signal: abandoned })
  })

  it('asks the tab in front when the caller resolves no tab', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const caller = { window: () => undefined, stillOn: () => true }

    await createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))(ORIGIN, 'fs', [], caller)

    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: undefined })
  })

  it('shows the question as a guarded consent: Allow waits, Deny is the way out', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    await createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))(ORIGIN, 'fs', [])

    expect(specOf()).toMatchObject({ kind: 'consent', buttons: ['Allow', 'Deny'], cancelId: 1, guarded: [0], focus: 'dialog' })
  })
})
