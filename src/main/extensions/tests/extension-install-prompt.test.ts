import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionInstallDescription } from '../../../broker/policy/extension-manifest.js'
import type { QuestionResult, QuestionSpec } from '../../shell/question/question-spec.js'

// The install question is asked through the shell's question panel. `askQuestion` is replaced so nothing is
// shown and the spec it receives can be read back; this suite confirms the plumbing (the right spec, the
// right button maps to true/false, the panel is told the tab the person asked from). Wording is
// extension-manifest.test.ts's job.
const askQuestion = vi.hoisted(() => vi.fn(async (_target: unknown, _spec: QuestionSpec): Promise<QuestionResult> => ({ response: 1, checkboxChecked: false })))
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion }))

const { createExtensionInstallPrompt } = await import('../extension-install-prompt.js')

const DESCRIPTION: ExtensionInstallDescription = {
  title: 'Load "Fixture"?',
  message: 'Fixture',
  detail: 'Read and change all your data on all websites',
  warning: true
}

const specOf = (): QuestionSpec => {
  const spec = askQuestion.mock.calls[0]?.[1]
  if (spec === undefined) throw new Error('no question was asked')
  return spec
}

describe('createExtensionInstallPrompt', () => {
  beforeEach(() => { askQuestion.mockClear() })

  it('resolves true when the person picks the first (Add extension) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await createExtensionInstallPrompt()(DESCRIPTION)).toBe(true)
  })

  it('resolves false when the person picks the second (Cancel) button', async () => {
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await createExtensionInstallPrompt()(DESCRIPTION)).toBe(false)
  })

  it('cancels by default, guards Add extension and starts on the panel: dismissing must never install', async () => {
    await createExtensionInstallPrompt()(DESCRIPTION)
    const spec = specOf()
    expect(spec.buttons).toEqual(['Add extension', 'Cancel'])
    expect(spec.cancelId).toBe(1)
    expect(spec.guarded).toEqual([0])
    expect(spec.focus).toBe('dialog')
    expect(spec.kind).toBe('consent')
  })

  it('labels the agreeing button with the description\'s own word, so a removal does not say Add extension', async () => {
    await createExtensionInstallPrompt()({ ...DESCRIPTION, accept: 'Remove' })
    expect(specOf().buttons).toEqual(['Remove', 'Cancel'])
  })

  it('draws a warning panel when the description warns, and a plain one otherwise', async () => {
    await createExtensionInstallPrompt()(DESCRIPTION)
    expect(specOf().warning).toBe(true)
    askQuestion.mockClear()
    await createExtensionInstallPrompt()({ ...DESCRIPTION, warning: false })
    expect(specOf().warning).toBe(false)
  })

  it('passes the description\'s title/message/detail straight through, and names no page', async () => {
    await createExtensionInstallPrompt()(DESCRIPTION)
    const spec = specOf()
    expect(spec.title).toBe(DESCRIPTION.title)
    expect(spec.message).toBe(DESCRIPTION.message)
    expect(spec.detail).toBe(DESCRIPTION.detail)
    expect(spec.origin).toBeUndefined()
  })

  it('asks in the tab of the page the person installed from, or the tab in front when no page asked', async () => {
    const contents = {}
    await createExtensionInstallPrompt()(DESCRIPTION, { contents })
    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents })
    askQuestion.mockClear()
    await createExtensionInstallPrompt()(DESCRIPTION)
    expect(askQuestion.mock.calls[0]?.[0]).toEqual({ contents: undefined })
  })
})
