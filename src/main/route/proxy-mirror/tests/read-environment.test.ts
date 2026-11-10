import { describe, expect, it } from 'vitest'
import { environmentReader, environmentSettings } from '../read-environment.js'

const PAC = 'http://127.0.0.1:8123/proxy.pac'

describe('the environment\'s auto_proxy', () => {
  it('is a script when it holds an address, as the address stands', () => {
    expect(environmentSettings({ auto_proxy: PAC })).toEqual({ kind: 'script', url: PAC })
    expect(environmentSettings({ auto_proxy: 'HTTPS://wpad.test/proxy.pac?x=1' })).toEqual({ kind: 'script', url: 'HTTPS://wpad.test/proxy.pac?x=1' })
    expect(environmentSettings({ auto_proxy: `  ${PAC}  ` })).toEqual({ kind: 'script', url: `  ${PAC}  ` })
  })

  it('is automatic detection when it is set and empty, and then beats the manual variables beside it', () => {
    expect(environmentSettings({ auto_proxy: '' })).toEqual({ kind: 'detect' })
    expect(environmentSettings({ auto_proxy: '', http_proxy: 'http://127.0.0.1:7777' })).toEqual({ kind: 'detect' })
  })

  it('is no proxy when what it holds is not an address: a path, an address with no scheme, white space', () => {
    for (const value of ['/etc/proxy.pac', '127.0.0.1:8123/proxy.pac', 'not a url', '   ']) {
      expect(environmentSettings({ auto_proxy: value }), JSON.stringify(value)).toEqual({ kind: 'none' })
    }
  })

  it('is read in lower case first, then in upper case, and an empty lower case one shadows the upper case one', () => {
    expect(environmentSettings({ AUTO_PROXY: PAC })).toEqual({ kind: 'script', url: PAC })
    expect(environmentSettings({ auto_proxy: PAC, AUTO_PROXY: 'http://other.test/proxy.pac' })).toEqual({ kind: 'script', url: PAC })
    expect(environmentSettings({ auto_proxy: '', AUTO_PROXY: PAC })).toEqual({ kind: 'detect' })
  })

  it('wins over the manual variables and ignores no_proxy, so nothing but the mirror keeps a name off the script\'s proxy', () => {
    const env = { auto_proxy: PAC, http_proxy: 'http://127.0.0.1:7777', https_proxy: 'http://127.0.0.1:7777', all_proxy: 'http://127.0.0.1:7777', no_proxy: '.eth' }
    expect(environmentSettings(env)).toEqual({ kind: 'script', url: PAC })
  })

  it('is not read at all when it is not set: the manual variables stay with the system', () => {
    expect(environmentSettings({})).toBeUndefined()
    expect(environmentSettings({ http_proxy: 'http://127.0.0.1:7777', https_proxy: 'http://127.0.0.1:7777', no_proxy: '.eth' })).toBeUndefined()
    expect(environmentSettings({ auto_proxy: undefined })).toBeUndefined()
  })
})

describe('the reader of the environment\'s auto_proxy', () => {
  it('gives the same settings every time it is asked', async () => {
    const read = environmentReader({ auto_proxy: PAC })
    expect(read).toBeDefined()
    expect(await read?.()).toEqual({ kind: 'script', url: PAC })
    expect(await read?.()).toEqual({ kind: 'script', url: PAC })
  })

  it('does not exist when auto_proxy is not set, so the mirror has nothing to poll', () => {
    expect(environmentReader({})).toBeUndefined()
    expect(environmentReader({ http_proxy: 'http://127.0.0.1:7777' })).toBeUndefined()
  })

  it('does not look at the environment again after it was made', async () => {
    const env: Record<string, string | undefined> = { auto_proxy: PAC }
    const read = environmentReader(env)
    env['auto_proxy'] = ''
    expect(await read?.()).toEqual({ kind: 'script', url: PAC })
  })
})
