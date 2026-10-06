import { describe, expect, it, vi } from 'vitest'
import { createFileHandler, localPathOf, type FileHandlerDeps } from '../file-handler.js'
import { INERT_FILE_CSP, LOCAL_FILE_CSP } from '../local-file-csp.js'

function served (body = 'file-body', headers: Record<string, string> = { 'content-type': 'text/html' }): Response {
  return new Response(body, { status: 200, headers })
}

function handler (overrides: Partial<FileHandlerDeps> = {}): { handle: (url: string, method?: string) => Promise<Response>, fetchFile: ReturnType<typeof vi.fn> } {
  const fetchFile = vi.fn(async () => served())
  const handle = createFileHandler({ kind: 'local', fetchFile, platform: 'linux', ...overrides })
  return { handle: async (url, method = 'GET') => await handle(new Request(url, { method })), fetchFile }
}

describe('localPathOf', () => {
  it.each([
    ['file:///home/u/a.html', 'linux', '/home/u/a.html'],
    ['file:///home/u/a%20b.html', 'linux', '/home/u/a b.html'],
    ['file:///C:/Users/u/a.html', 'win32', 'C:\\Users\\u\\a.html']
  ] as const)('%s on %s is %s', (url, platform, expected) => {
    expect(localPathOf(new URL(url), platform)).toBe(expected)
  })

  it.each([
    ['a host', 'file://server/share/a.html', 'linux'],
    ['a // path', 'file:////server/share/a.html', 'linux'],
    ['an encoded slash', 'file:///home/u/a%2Fb.html', 'linux'],
    ['a UNC path on Windows', 'file://server/share/a.html', 'win32'],
    ['a Windows device path', 'file:///%5C%5C.%5CC:/a.html', 'win32'],
    ['a Windows extended path', 'file:///%5C%5C%3F%5CC:/a.html', 'win32'],
    ['a web URL', 'https://x.example/a.html', 'linux']
  ] as const)('refuses %s', (_name, url, platform) => {
    expect(localPathOf(new URL(url), platform)).toBeNull()
  })
})

describe('the local-files handler', () => {
  it('serves the file Chromium would, with the local-file policy added to its headers', async () => {
    const { handle, fetchFile } = handler()

    const response = await handle('file:///home/u/a.html')

    expect(await response.text()).toBe('file-body')
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.headers.get('content-security-policy')).toBe(LOCAL_FILE_CSP)
    expect(fetchFile).toHaveBeenCalledOnce()
  })

  it('forbids sniffing, so a text file is never run as a script or a stylesheet', async () => {
    const { handle } = handler()

    expect((await handle('file:///home/u/a.html')).headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('adds a granted document\'s own policy as a second header value, for that document\'s key', async () => {
    const extraPolicy = vi.fn(async (key: string) => key === 'file:///home/u/a.html' ? "default-src 'self'" : undefined)
    const { handle } = handler({ extraPolicy })

    const granted = await handle('file:///home/u/a.html?x=1')
    const plain = await handle('file:///home/u/b.html')

    expect(granted.headers.get('content-security-policy')).toBe(`${LOCAL_FILE_CSP}, default-src 'self'`)
    expect(plain.headers.get('content-security-policy')).toBe(LOCAL_FILE_CSP)
    expect(extraPolicy).toHaveBeenCalledWith('file:///home/u/a.html')
  })

  it('passes the status of a missing file through with the policy still on it', async () => {
    const { handle } = handler({ fetchFile: async () => new Response('', { status: 404 }) })

    const response = await handle('file:///home/u/none.html')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-security-policy')).toBe(LOCAL_FILE_CSP)
  })

  it.each([
    ['a host', 'file://server/share/a.html'],
    ['a // path', 'file:////server/share/a.html'],
    ['an encoded slash', 'file:///home/u/a%2Fb.html']
  ])('refuses %s without reading anything', async (_name, url) => {
    const { handle, fetchFile } = handler()

    expect((await handle(url)).status).toBe(403)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('refuses a UNC path on Windows without reading anything', async () => {
    const { handle, fetchFile } = handler({ platform: 'win32' })

    expect((await handle('file://server/share/a.html')).status).toBe(403)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('refuses a method that is not GET or HEAD', async () => {
    const { handle, fetchFile } = handler()

    expect((await handle('file:///home/u/a.html', 'POST')).status).toBe(405)
    expect((await handle('file:///home/u/a.html', 'HEAD')).status).toBe(200)
    expect(fetchFile).toHaveBeenCalledOnce()
  })
})

describe('the guard on a session that is not the local-files session', () => {
  const shell = { kind: 'guarded', passThroughRoot: '/app/out/renderer' } as const

  it('serves the built shell pages as they are, with no policy added', async () => {
    const { handle, fetchFile } = handler(shell)

    const response = await handle('file:///app/out/renderer/newtab/index.html')

    expect(await response.text()).toBe('file-body')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(fetchFile).toHaveBeenCalledOnce()
  })

  it('answers any other file with an empty page under a sandbox that allows nothing, reading nothing', async () => {
    const { handle, fetchFile } = handler(shell)

    const response = await handle('file:///home/u/a.html')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(response.headers.get('content-security-policy')).toBe(INERT_FILE_CSP)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('does not treat a sibling folder with the same prefix, or a dot-dot path, as the shell\'s own', async () => {
    const { handle, fetchFile } = handler(shell)

    for (const url of ['file:///app/out/renderer-evil/a.html', 'file:///app/out/renderer/../main/a.html', 'file:///app/out/renderer']) {
      expect(await (await handle(url)).text()).toBe('')
    }
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('compares Windows paths without regard to case and refuses a share', async () => {
    const win = { kind: 'guarded', passThroughRoot: 'C:\\App\\out\\renderer', platform: 'win32' } as const
    const { handle, fetchFile } = handler(win)

    expect(await (await handle('file:///c:/app/out/renderer/index.html')).text()).toBe('file-body')
    expect((await handle('file://server/share/index.html')).status).toBe(403)
    expect(fetchFile).toHaveBeenCalledOnce()
  })

  it('serves nothing from a guarded session built with no shell folder', async () => {
    const { handle, fetchFile } = handler({ kind: 'guarded' })

    expect(await (await handle('file:///app/out/renderer/index.html')).text()).toBe('')
    expect(fetchFile).not.toHaveBeenCalled()
  })
})
