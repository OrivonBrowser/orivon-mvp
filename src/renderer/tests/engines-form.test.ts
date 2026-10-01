import { describe, expect, it } from 'vitest'
import { draftOf, emptyDraft, markColor, markLetter, problemFor } from '../pages/settings/engines-form.js'

describe('problemFor', () => {
  it('names the owner of a keyword that is taken', () => {
    expect(problemFor({ field: 'keyword', reason: 'used', usedBy: 'Wikipedia' })).toEqual({ field: 'keyword', text: 'This keyword is already used by Wikipedia.' })
  })

  it.each([
    [{ field: 'name', reason: 'required' }, 'name', 'Give the search engine a name.'],
    [{ field: 'name', reason: 'too-long' }, 'name', 'Use 60 characters or fewer.'],
    [{ field: 'keyword', reason: 'format' }, 'keyword', 'Use letters, digits, dots, hyphens or underscores, with no spaces.'],
    [{ field: 'keyword', reason: 'too-long' }, 'keyword', 'Use 20 characters or fewer.'],
    [{ field: 'template', reason: 'template' }, 'template', 'Use an address that starts with https://, has %s where the search goes, and has no user name or password.']
  ])('puts %j under %s', (refusal, field, text) => {
    expect(problemFor(refusal)).toEqual({ field, text })
  })

  it('shows a refusal with no field under the form', () => {
    expect(problemFor({ reason: 'private' })).toEqual({ field: null, text: 'Search engines cannot be changed in a private window.' })
    expect(problemFor({ reason: 'limit' }).field).toBeNull()
  })

  it('has a message for a reason it does not know, and ignores a field that is not one', () => {
    expect(problemFor({ field: 'nope', reason: 'strange' })).toEqual({ field: null, text: 'That search engine cannot be saved.' })
  })
})

describe('drafts and marks', () => {
  it('starts empty and copies an engine', () => {
    expect(emptyDraft()).toEqual({ name: '', keyword: '', template: '' })
    expect(draftOf({ id: 'a', name: 'Docs', keyword: 'd', template: 'https://d.example/?q=%s', kind: 'custom' })).toEqual({ name: 'Docs', keyword: 'd', template: 'https://d.example/?q=%s' })
  })

  it('draws the first letter, capitalised, and always the same colour for a name', () => {
    expect(markLetter('wikipedia')).toBe('W')
    expect(markLetter('  éclair')).toBe('É')
    expect(markLetter('')).toBe('?')
    expect(markColor('Wikipedia')).toBe(markColor('Wikipedia'))
    expect(['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal']).toContain(markColor('YouTube'))
  })
})
