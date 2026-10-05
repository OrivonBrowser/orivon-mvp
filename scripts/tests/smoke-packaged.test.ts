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

  it('finds the chrome page loaded from the asar on each system', () => {
    const linux = page('file:///opt/Orivon/resources/app.asar/out/renderer/index.html')
    const windows = page('file:///C:/Users/runner/AppData/Local/Programs/Orivon/resources/app.asar/out/renderer/index.html')
    const mac = page('file:///Volumes/Orivon/Orivon.app/Contents/Resources/app.asar/out/renderer/index.html')
    for (const target of [linux, windows, mac]) expect(shellTarget([page('about:blank'), target])).toBe(target)
  })

  it('ignores a build run from source, other renderer pages and non-page targets', () => {
    expect(shellTarget([
      page('file:///home/dev/orivon/out/renderer/index.html'),
      page('file:///opt/Orivon/resources/app.asar/out/renderer/intro/index.html'),
      { type: 'service_worker', url: 'file:///opt/Orivon/resources/app.asar/out/renderer/index.html' }
    ])).toBeUndefined()
  })
})
