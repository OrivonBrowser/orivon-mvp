import { describe, expect, it } from 'vitest'
import { aliasToInternal, viewSourceTarget } from '../internal-aliases.js'

describe('aliasToInternal', () => {
  it.each([
    ['about:version', 'about', '/'],
    ['about:about', 'about', '/'],
    ['about:gpu', 'about', '/gpu'],
    ['chrome://version', 'about', '/'],
    ['chrome://gpu', 'about', '/gpu'],
    ['chrome://about', 'about', '/'],
    ['chrome://task-manager', 'tasks', '/'],
    ['about:task-manager', 'tasks', '/'],
    ['about:settings', 'settings', '/'],
    ['chrome://history', 'history', '/'],
    ['chrome://extensions/', 'extensions', '/'],
    ['chrome://settings/search', 'settings', '/search'],
    ['about:tasks', 'tasks', '/']
  ])('reads %s as orivon://%s%s', (input, page, path) => {
    expect(aliasToInternal(input)).toEqual({ page, path })
  })

  it('ignores capitals and surrounding space', () => {
    expect(aliasToInternal('  About:Version ')).toEqual({ page: 'about', path: '/' })
    expect(aliasToInternal('CHROME://GPU')).toEqual({ page: 'about', path: '/gpu' })
  })

  it.each([
    'about:blank',
    'about:',
    'about://version',
    'chrome://',
    'chrome://private',
    'about:private',
    'chrome://evil.example',
    'chrome://version?x=1',
    'chrome://gpu#top',
    'about:version?x=1',
    'chrome://gpu/extra',
    'chrome://version/x',
    'chrome://settings/../history',
    'chrome://settings//x',
    'chrome://settings/a b',
    'chrome://no-such-page',
    'chrome-extension://abc/page.html',
    'chrome:version',
    'orivon://version',
    'https://version.example/',
    'javascript:alert(1)',
    'version',
    ''
  ])('leaves %j to behave as it did', (input) => {
    expect(aliasToInternal(input)).toBeNull()
  })
})

describe('viewSourceTarget', () => {
  it('returns the web address after view-source:', () => {
    expect(viewSourceTarget('view-source:https://a.example/')).toBe('https://a.example/')
    expect(viewSourceTarget('  VIEW-SOURCE: http://a.example/x?y=1 ')).toBe('http://a.example/x?y=1')
  })

  it.each([
    'view-source:javascript:1',
    'view-source:file:///etc/passwd',
    'view-source:data:text/html,x',
    'view-source:about:blank',
    'view-source:view-source:https://a.example/',
    'view-source:',
    'view-source:example.com',
    'https://a.example/',
    'not view-source:https://a.example/'
  ])('gives nothing for %j, so it stays a search or stays refused', (input) => {
    expect(viewSourceTarget(input)).toBeNull()
  })
})
