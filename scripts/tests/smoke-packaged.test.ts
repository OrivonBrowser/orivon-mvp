import { describe, expect, it } from 'vitest'
import { devToolsPort, shellTarget } from '../smoke-packaged.mjs'

describe('devToolsPort', () => {
  it('reads the port from the line Chromium prints', () => {
    const output = 'some log\n\nDevTools listening on ws://127.0.0.1:41235/devtools/browser/5d1c-4e2f\nmore log'
    expect(devToolsPort(output)).toBe(41235)
  })

  it('is undefined until that line arrives', () => {
    expect(devToolsPort('[orivon] starting\n')).toBeUndefined()
  })
})

describe('shellTarget', () => {
  const page = (url: string): { type: string, url: string, webSocketDebuggerUrl: string } =>
    ({ type: 'page', url, webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' })

  it('finds the chrome page by its shell-scheme address, the same on every system', () => {
    const chrome = page('orivon-shell://renderer/index.html')
    const withQuery = page('orivon-shell://renderer/index.html?window=2')
    for (const target of [chrome, withQuery]) expect(shellTarget([page('about:blank'), target])).toBe(target)
  })

  it('ignores other shell pages, a website that quotes the address, the old file address and non-page targets', () => {
    expect(shellTarget([
      page('orivon-shell://renderer/newtab/index.html'),
      page('orivon-shell://renderer/intro/index.html'),
      page('https://site.example/?next=orivon-shell://renderer/index.html'),
      page('https://site.example/orivon-shell://renderer/index.html'),
      page('file:///opt/Orivon/resources/app.asar/out/renderer/index.html'),
      { type: 'service_worker', url: 'orivon-shell://renderer/index.html' }
    ])).toBeUndefined()
  })
})
