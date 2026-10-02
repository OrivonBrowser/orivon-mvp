import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuestionResult, QuestionSpec } from '../question/question-spec.js'

// The question a page can make the shell ask (an external link; notifications ask through the per-site prompt).
// `askQuestion` is replaced so nothing is shown and the spec each question passes can be read back; `response`
// is the button the "person" chose.
const askQuestion = vi.hoisted(() => vi.fn(async (_target: unknown, _spec: QuestionSpec, _options?: unknown): Promise<QuestionResult> => ({ response: 0, checkboxChecked: false })))
vi.mock('../question/ask-question.js', () => ({ askQuestion }))

const { confirmExternalLink, displayableUrl } = await import('../external-link-prompt.js')

const TAB = { contents: {} }

function lastSpec (): QuestionSpec {
  const spec = askQuestion.mock.calls.at(-1)?.[1]
  if (spec === undefined) throw new Error('no question was asked')
  return spec
}

beforeEach(() => { askQuestion.mockClear() })

describe('confirmExternalLink', () => {
  const question = { scheme: 'magnet', url: 'magnet:?xt=urn:btih:00&dn=film', origin: 'https://tracker.example' }

  it('asks in the given tab, naming the scheme, the URL and who is asking', async () => {
    await confirmExternalLink(TAB, question)
    expect(askQuestion.mock.calls[0]?.[0]).toBe(TAB)
    const spec = lastSpec()
    expect(spec.message).toBe('Open magnet link with your system\'s default app?')
    expect(spec.detail).toBe('https://tracker.example wants to open:\nmagnet:?xt=urn:btih:00&dn=film')
    expect(spec.buttons).toEqual(['Allow', 'Cancel'])
    expect(spec.kind).toBe('consent')
  })

  it('does not say a site wants anything when the person started it', async () => {
    await confirmExternalLink(TAB, { scheme: 'mailto', url: 'mailto:?subject=Page', origin: 'https://site.example', initiator: 'person' })
    const spec = lastSpec()
    expect(spec.message).toBe('Open your mail program with this page\'s link?')
    expect(spec.detail).toBe('mailto:?subject=Page')
    expect(JSON.stringify(spec)).not.toContain('site.example')
  })

  // Enter and Escape must both land on Cancel: a stray key press never launches another app.
  it('cancels by default, guards Allow, and starts on the panel rather than a button', async () => {
    await confirmExternalLink(TAB, question)
    const spec = lastSpec()
    expect(spec.buttons[spec.cancelId]).toBe('Cancel')
    expect(spec.guarded).toEqual([0])
    expect(spec.focus).toBe('dialog')
  })

  it('ends when the tab loads another page', async () => {
    await confirmExternalLink(TAB, question)
    expect(askQuestion.mock.calls[0]?.[2]).toEqual({ endOnNavigation: true })
  })

  it('is true only for Allow', async () => {
    askQuestion.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await confirmExternalLink(TAB, question)).toBe(true)
    askQuestion.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await confirmExternalLink(TAB, question)).toBe(false)
  })

  it('shows the origin the way every permission dialog does, keeping the labels that decide who it is', async () => {
    await confirmExternalLink(TAB, { ...question, origin: 'https://accounts.google.com.attacker.example' })
    expect(lastSpec().detail).toMatch(/^https:\/\/\.\.\.com\.attacker\.example wants to open:/)
  })
})

describe('displayableUrl', () => {
  it('shows a short URL whole', () => {
    expect(displayableUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('cuts a long URL, and says so', () => {
    const shown = displayableUrl(`bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?message=${'x'.repeat(500)}`)
    expect(shown.length).toBeLessThanOrEqual(200)
    expect(shown.endsWith('...')).toBe(true)
  })

  // A bidi override or a line break would let the URL rewrite the lines
  // around it; shown escaped, it can only ever read as itself.
  it('escapes every character that is not printable ASCII', () => {
    expect(displayableUrl('mailto:a@b.example?subject=\u202Etxt.exe\nsecond line')).toBe('mailto:a@b.example?subject=%E2%80%AEtxt.exe%0Asecond line')
  })
})
