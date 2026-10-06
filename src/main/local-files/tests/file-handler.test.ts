import { describe, expect, it, vi } from 'vitest'
import { createFileHandler, localPathOf, type FileHandlerDeps } from '../file-handler.js'
import type { FileProtocolFuse } from '../file-fuse.js'

function served (body = 'file-body', headers: Record<string, string> = { 'content-type': 'text/html' }): Response {
  return new Response(body, { status: 200, headers })
}

function handler (overrides: Partial<FileHandlerDeps> = {}, fuse: FileProtocolFuse = 'off'): { handle: (url: string, method?: string) => Promise<Response>, fetchFile: ReturnType<typeof vi.fn> } {
  const fetchFile = vi.fn(async () => served())
  const handle = createFileHandler({ fetchFile, fuse: async () => fuse, platform: 'linux', ...overrides })
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
  it('serves the file Chromium would, byte for byte, with no policy of its own on an ordinary file', async () => {
    const { handle, fetchFile } = handler()

    const response = await handle('file:///home/u/a.html')

    expect(await response.text()).toBe('file-body')
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(fetchFile).toHaveBeenCalledOnce()
  })

  it('forbids sniffing on every response, so a text file is never run as a script or a stylesheet', async () => {
    const { handle } = handler()

    expect((await handle('file:///home/u/a.html')).headers.get('x-content-type-options')).toBe('nosniff')
    expect((await handle('file:///home/u/notes.txt', 'HEAD')).headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('adds a granted document\'s own policy for that document\'s key, query and fragment aside', async () => {
    const extraPolicy = vi.fn(async (key: string) => key === 'file:///home/u/a.html' ? "default-src 'self'" : undefined)
    const { handle } = handler({ extraPolicy })

    const granted = await handle('file:///home/u/a.html?x=1')
    const plain = await handle('file:///home/u/b.html')

    expect(granted.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(plain.headers.get('content-security-policy')).toBeNull()
    expect(extraPolicy).toHaveBeenCalledWith('file:///home/u/a.html')
  })

  it('keeps a policy the file\'s own response already carried, and adds a second', async () => {
    const fetchFile = vi.fn(async () => served('x', { 'content-security-policy': "img-src 'none'" }))
    const { handle } = handler({ fetchFile, extraPolicy: async () => "default-src 'self'" })

    const response = await handle('file:///home/u/a.html')

    expect(response.headers.get('content-security-policy')).toBe("img-src 'none', default-src 'self'")
  })

  it('answers a status Chromium gave unchanged, an empty 404 included', async () => {
    const { handle } = handler({ fetchFile: async () => new Response('', { status: 404 }) })

    expect((await handle('file:///home/u/gone.html')).status).toBe(404)
  })

  it('refuses a host, a share and a // path with 403, before reading anything', async () => {
    const { handle, fetchFile } = handler()

    for (const url of ['file://server/share/a.html', 'file:////server/share/a.html']) {
      expect((await handle(url)).status).toBe(403)
    }
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('refuses any method but GET and HEAD', async () => {
    const { handle, fetchFile } = handler()

    expect((await handle('file:///home/u/a.html', 'POST')).status).toBe(405)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it.each<FileProtocolFuse>(['on', 'unknown'])('serves nothing while the binary\'s file-protocol fuse reads %s', async (fuse) => {
    const { handle, fetchFile } = handler({}, fuse)

    expect((await handle('file:///home/u/a.html')).status).toBe(403)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('refuses a Windows path that names no drive', async () => {
    const { handle, fetchFile } = handler({ platform: 'win32' })

    expect((await handle('file:///%5C%5C.%5CC:/a.html')).status).toBe(403)
    expect(fetchFile).not.toHaveBeenCalled()
  })
})
