import { describe, expect, it } from 'vitest'
import { backLabel, BODY, CONTINUE_LABEL, isView, TITLE } from '../model.js'

describe('the https-warning sheet model', () => {
  it('reads a view main sends', () => {
    expect(isView({ host: 'site.example', canGoBack: true })).toBe(true)
    expect(isView({ host: '', canGoBack: true })).toBe(false)
    expect(isView({ host: 'site.example' })).toBe(false)
    expect(isView({ host: 7, canGoBack: false })).toBe(false)
    expect(isView(null)).toBe(false)
    expect(isView('site.example')).toBe(false)
  })

  it('names the safe button for what it will do', () => {
    expect(backLabel(true)).toBe('Go back')
    expect(backLabel(false)).toBe('Close tab')
  })

  it('says what is at risk and why the page did not open', () => {
    expect(TITLE).toBe('This site does not support a secure connection')
    expect(BODY).toContain('Always use secure connections')
    expect(CONTINUE_LABEL).toBe('Continue to the HTTP site')
  })
})
