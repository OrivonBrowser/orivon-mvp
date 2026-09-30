import { describe, expect, it } from 'vitest'
import { checkDraft, isKeywordText } from '../search-engine-rules.js'
import type { EngineView } from '../search-resolve.js'

const others: EngineView[] = [{ id: 'a', name: 'Alpha', keyword: 'al', template: 'https://a.example/?q=%s', kind: 'custom' }]
const good = { name: 'Docs', keyword: 'docs', template: 'https://docs.example/search?q=%s' }

describe('checkDraft', () => {
  it('accepts a good draft and trims it', () => {
    expect(checkDraft({ name: '  Docs ', keyword: ' docs ', template: ` ${good.template} ` }, others)).toEqual({ ok: true, value: good })
  })

  it.each([
    [{ ...good, name: '' }, 'name', 'required'],
    [{ ...good, name: '   ' }, 'name', 'required'],
    [{ ...good, name: 'x'.repeat(61) }, 'name', 'too-long'],
    [{ ...good, name: 'two\nlines' }, 'name', 'format'],
    [{ ...good, keyword: '' }, 'keyword', 'required'],
    [{ ...good, keyword: 'k'.repeat(21) }, 'keyword', 'too-long'],
    [{ ...good, keyword: 'a b' }, 'keyword', 'format'],
    [{ ...good, keyword: 'https:' }, 'keyword', 'format'],
    [{ ...good, template: '' }, 'template', 'required'],
    [{ ...good, template: 'https://docs.example/search' }, 'template', 'template'],
    [{ ...good, template: 'http://docs.example/?q=%s' }, 'template', 'template'],
    [{ ...good, template: 'https://%s.example/' }, 'template', 'template'],
    [{ ...good, template: 'https://user:pw@docs.example/?q=%s' }, 'template', 'template']
  ] as const)('refuses %j as %s %s', (draft, field, reason) => {
    expect(checkDraft(draft, others)).toMatchObject({ ok: false, field, reason })
  })

  it('takes a name of exactly 60 characters and a keyword of exactly 20', () => {
    expect(checkDraft({ ...good, name: 'n'.repeat(60), keyword: 'k'.repeat(20) }, others).ok).toBe(true)
  })

  it('takes http on this computer', () => {
    expect(checkDraft({ ...good, template: 'http://127.0.0.1:8080/?q=%s' }, others).ok).toBe(true)
  })

  it('refuses a keyword another engine has, whatever its case, and says whose', () => {
    expect(checkDraft({ ...good, keyword: 'AL' }, others)).toEqual({ ok: false, field: 'keyword', reason: 'used', usedBy: 'Alpha' })
  })
})

describe('isKeywordText', () => {
  it.each([['w', true], ['a.b-c_d', true], ['a b', false], ['a:b', false], ['a/b', false], ['', false], ['é', false]])('%j is %j', (text, ok) => {
    expect(isKeywordText(text)).toBe(ok)
  })
})
