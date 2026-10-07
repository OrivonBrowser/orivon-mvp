import { describe, expect, it } from 'vitest'
import { childProcessName, isOrdinaryEnd, processName, rendererLine, shellPageName } from '../shell-console.js'

describe('shellPageName', () => {
  it('names an orivon:// page, an entry of the built shell and the dev server\'s entries', () => {
    expect(shellPageName('orivon://settings/privacy', undefined)).toBe('settings')
    expect(shellPageName('orivon-shell://renderer/index.html', undefined)).toBe('chrome')
    expect(shellPageName('orivon-shell://renderer/overlay/index.html', undefined)).toBe('overlay')
    expect(shellPageName('http://localhost:5173/split-frame/index.html', 'http://localhost:5173')).toBe('split-frame')
  })

  it('is undefined for a website, an app, another host of the shell scheme and the dev server when none runs', () => {
    expect(shellPageName('https://example.org/overlay/', undefined)).toBeUndefined()
    expect(shellPageName('https://abc.eth/', 'http://localhost:5173')).toBeUndefined()
    expect(shellPageName('orivon-shell://other/x', undefined)).toBeUndefined()
    expect(shellPageName('http://localhost:5173/x', undefined)).toBeUndefined()
    expect(shellPageName('not a url', undefined)).toBeUndefined()
    expect(shellPageName('about:blank', undefined)).toBeUndefined()
  })
})

describe('rendererLine', () => {
  it('keeps warnings and errors with the page and the source', () => {
    expect(rendererLine('error', 'overlay', 'boom', 'orivon-shell://renderer/overlay/page.ts', 12)).toEqual({ level: 'error', text: '[renderer:overlay] boom (overlay/page.ts:12)' })
    expect(rendererLine('warning', 'settings', 'hmm', '', 0)).toEqual({ level: 'warn', text: '[renderer:settings] hmm' })
  })

  it('drops the routine levels', () => {
    expect(rendererLine('info', 'x', 'a', '', 0)).toBeUndefined()
    expect(rendererLine('debug', 'x', 'a', '', 0)).toBeUndefined()
  })
})

describe('processName', () => {
  const base = { internalPage: undefined, isTab: false, url: '', devOrigin: undefined }
  it('names the kind of page that died', () => {
    expect(processName({ ...base, internalPage: 'settings' })).toBe('page:settings')
    expect(processName({ ...base, isTab: true, url: 'https://a.org/' })).toBe('tab')
    expect(processName({ ...base, url: 'chrome-extension://abc/background.html' })).toBe('extension')
    expect(processName({ ...base, url: 'https://abc.eth/.well-known/orivon/child-host' })).toBe('app-host')
    expect(processName({ ...base, url: 'orivon-shell://renderer/overlay/index.html' })).toBe('shell')
    expect(processName({ ...base, url: 'https://elsewhere.org/' })).toBe('tab')
  })
})

describe('childProcessName', () => {
  it('names a utility process by its service', () => {
    expect(childProcessName({ type: 'GPU', serviceName: undefined, name: undefined })).toBe('GPU')
    expect(childProcessName({ type: 'Utility', serviceName: 'network.mojom.NetworkService', name: 'Network Service' })).toBe('Utility:network.mojom.NetworkService')
    expect(childProcessName({ type: 'Utility', serviceName: undefined, name: 'Audio Service' })).toBe('Utility:Audio Service')
    expect(childProcessName({ type: 'Utility', serviceName: undefined, name: undefined })).toBe('Utility')
  })
})

describe('isOrdinaryEnd', () => {
  it('is true for a clean exit of either kind', () => {
    expect(isOrdinaryEnd('renderer', 'clean-exit', false)).toBe(true)
    expect(isOrdinaryEnd('child', 'clean-exit', false)).toBe(true)
  })

  it('is true for a utility process Orivon killed itself, and for a memory eviction of either kind', () => {
    expect(isOrdinaryEnd('child', 'killed', false)).toBe(true)
    expect(isOrdinaryEnd('child', 'memory-eviction', false)).toBe(true)
    expect(isOrdinaryEnd('renderer', 'memory-eviction', false)).toBe(true)
  })

  it('keeps a renderer that was killed, which the operating system may have done, unless the browser is quitting', () => {
    expect(isOrdinaryEnd('renderer', 'killed', false)).toBe(false)
    expect(isOrdinaryEnd('renderer', 'killed', true)).toBe(true)
  })

  it('keeps the crashes', () => {
    for (const reason of ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']) {
      expect(isOrdinaryEnd('renderer', reason, true)).toBe(false)
      expect(isOrdinaryEnd('child', reason, true)).toBe(false)
    }
  })
})
