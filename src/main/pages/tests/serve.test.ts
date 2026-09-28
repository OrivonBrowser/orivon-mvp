import { describe, expect, it, vi } from 'vitest'
import { createInternalHandler, internalCsp, withRootBase } from '../serve.js'

const ROOT = '/app/out/renderer'
const files = new Map<string, string>([
  [`${ROOT}/pages/settings/index.html`, '<!doctype html><html><head><title>s</title></head><body></body></html>'],
  [`${ROOT}/assets/settings-1.js`, 'console.log(1)'],
  [`${ROOT}/assets/settings-1.css`, 'body{}']
])
const readFile = vi.fn(async (path: string) => {
  const content = files.get(path)
  if (content === undefined) throw new Error(`ENOENT ${path}`)
  return new TextEncoder().encode(content)
})

function handler (devServerUrl?: string, fetchDev?: (url: string) => Promise<Response>) {
  return createInternalHandler({ rendererRoot: ROOT, devServerUrl, readFile, fetchDev })
}
const get = async (h: ReturnType<typeof handler>, url: string): Promise<Response> => await h(new Request(url))

describe('createInternalHandler', () => {
  it('serves a page, with the base pinned to the root and the strict policy on it', async () => {
    const response = await get(handler(), 'orivon://settings/privacy')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(body).toContain('<head><base href="/">')
    expect(response.headers.get('content-security-policy')).toBe(internalCsp(undefined))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves an asset with its own type', async () => {
    const js = await get(handler(), 'orivon://settings/assets/settings-1.js')
    const css = await get(handler(), 'orivon://settings/assets/settings-1.css')

    expect(await js.text()).toBe('console.log(1)')
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('answers 404 for a missing file, a page that does not exist and a host that is not a page', async () => {
    expect((await get(handler(), 'orivon://settings/assets/missing.js')).status).toBe(404)
    expect((await get(handler(), 'orivon://history/')).status).toBe(404)
    expect((await get(handler(), 'orivon://elsewhere/')).status).toBe(404)
  })

  it('reads nothing outside the renderer directory whatever the path says', async () => {
    readFile.mockClear()
    for (const url of [
      'orivon://settings/assets/../../../etc/passwd',
      'orivon://settings/assets/%2e%2e/%2e%2e/secret.js',
      'orivon://settings/assets/..%2f..%2fsecret.js'
    ]) {
      await get(handler(), url)
    }

    for (const [path] of readFile.mock.calls) expect(path.startsWith(`${ROOT}/`)).toBe(true)
  })

  it('allows the dev server\'s socket and nothing else to connect, only in development', () => {
    expect(internalCsp(undefined)).toContain("connect-src 'none'")
    expect(internalCsp('http://localhost:5173/')).toContain('connect-src ws://localhost:5173')
  })

  it('takes a page and its modules from the dev server, and refuses to read arbitrary files from it', async () => {
    const fetchDev = vi.fn(async (url: string) => new Response(url.endsWith('index.html') ? '<head></head>' : 'module', { headers: { 'content-type': 'text/javascript' } }))
    const dev = handler('http://localhost:5173', fetchDev)

    expect(await (await get(dev, 'orivon://settings/')).text()).toContain('<base href="/">')
    expect(fetchDev).toHaveBeenLastCalledWith('http://localhost:5173/pages/settings/index.html')
    expect(await (await get(dev, 'orivon://settings/@vite/client')).text()).toBe('module')
    expect(fetchDev).toHaveBeenLastCalledWith('http://localhost:5173/@vite/client')
    fetchDev.mockClear()
    expect((await get(dev, 'orivon://settings/@fs/etc/passwd')).status).toBe(404)
    expect(fetchDev).not.toHaveBeenCalled()
  })
})

describe('withRootBase', () => {
  it('goes in the head, or in front when there is none', () => {
    expect(withRootBase('<html><head lang="en"><meta></head></html>')).toBe('<html><head lang="en"><base href="/"><meta></head></html>')
    expect(withRootBase('<p>x</p>')).toBe('<base href="/"><p>x</p>')
  })
})
