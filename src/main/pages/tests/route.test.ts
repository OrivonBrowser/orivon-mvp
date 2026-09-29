import { describe, expect, it } from 'vitest'
import { routeInternalRequest } from '../route.js'

describe('routeInternalRequest', () => {
  it('serves a page for its address and for any place inside it', () => {
    expect(routeInternalRequest('orivon://settings/')).toEqual({ kind: 'page', page: 'settings' })
    expect(routeInternalRequest('orivon://settings/privacy')).toEqual({ kind: 'page', page: 'settings' })
    expect(routeInternalRequest('orivon://history/a/b/c/d?x=1#y')).toEqual({ kind: 'page', page: 'history' })
  })

  it('serves a plain file under assets/', () => {
    expect(routeInternalRequest('orivon://settings/assets/settings-BFwUrQay.js')).toEqual({ kind: 'asset', path: 'assets/settings-BFwUrQay.js' })
    expect(routeInternalRequest('orivon://settings/assets/logo.png')).toEqual({ kind: 'asset', path: 'assets/logo.png' })
  })

  it('refuses a host that is not a page', () => {
    for (const url of ['orivon://nope/', 'orivon://Settings.evil/', 'https://settings/assets/x.js', 'file:///etc/passwd', 'not a url', '']) {
      expect(routeInternalRequest(url)).toEqual({ kind: 'not-found' })
    }
  })

  it.each([
    'orivon://settings/assets/../../etc/passwd',
    'orivon://settings/assets/%2e%2e/%2e%2e/etc/passwd',
    'orivon://settings/assets/..%2f..%2fetc%2fpasswd.js',
    'orivon://settings/assets/%2E%2E%5C%2E%2E%5Csecret.js',
    'orivon://settings/assets/a%00.js',
    'orivon://settings/assets/a\\b.js',
    'orivon://settings/assets//x.js',
    'orivon://settings/assets/',
    'orivon://settings/assets/.',
    'orivon://settings/assets/%',
    'orivon://settings/assets/x.html',
    'orivon://settings/assets/x.json',
    'orivon://settings/assets/x.js.map',
    'orivon://settings/assets/noextension'
  ])('never reads outside assets/ or a file type it does not serve: %s', (url) => {
    const route = routeInternalRequest(url)
    if (route.kind === 'asset') {
      // The URL parser may resolve a dot-segment away; what is left must
      // still be a plain path under assets/.
      expect(route.path.startsWith('assets/')).toBe(true)
      expect(route.path.split('/')).not.toContain('..')
      expect(route.path).not.toMatch(/[\\\0]/)
    } else {
      expect(['not-found', 'page']).toContain(route.kind)
    }
  })

  it('serves the dev server\'s module paths only in development', () => {
    expect(routeInternalRequest('orivon://settings/@vite/client', false)).toEqual({ kind: 'page', page: 'settings' })
    expect(routeInternalRequest('orivon://settings/@vite/client', true)).toEqual({ kind: 'dev', path: '/@vite/client' })
    expect(routeInternalRequest('orivon://settings/pages/settings/main.ts?t=5', true)).toEqual({ kind: 'dev', path: '/pages/settings/main.ts?t=5' })
  })

  it('never lets the dev server read an arbitrary file', () => {
    for (const url of ['orivon://settings/@fs/etc/passwd', 'orivon://settings/@fs/home/user/.ssh/id_rsa', 'orivon://settings/@vite/../../etc/passwd']) {
      const route = routeInternalRequest(url, true)
      expect(route.kind === 'dev' ? route.path.includes('@fs') || route.path.includes('..') : false).toBe(false)
    }
    expect(routeInternalRequest('orivon://settings/@fs/etc/passwd', true)).toEqual({ kind: 'not-found' })
  })

  it('refuses a path that is encoded twice, which a later parse would read as a way up', () => {
    for (const url of ['orivon://settings/pages/%252e%252e/@fs/etc/passwd', 'orivon://settings/@vite/%252e%252e/%252e%252e/x', 'orivon://settings/assets/%252e%252e/x.js']) {
      expect(routeInternalRequest(url, true), url).toEqual({ kind: 'not-found' })
    }
  })

  describe('/@fs/, given the roots it may read', () => {
    const ROOT = '/home/user/orivon-mvp'
    const ROOTS = [`${ROOT}/src`, `${ROOT}/node_modules`]

    it('reaches a file inside one of them', () => {
      expect(routeInternalRequest(`orivon://settings/@fs${ROOT}/src/protocols/builtin.ts`, true, ROOTS))
        .toEqual({ kind: 'dev', path: `/@fs${ROOT}/src/protocols/builtin.ts` })
      expect(routeInternalRequest(`orivon://settings/@fs${ROOT}/node_modules/vite/dist/client/env.mjs?x=1`, true, ROOTS))
        .toEqual({ kind: 'dev', path: `/@fs${ROOT}/node_modules/vite/dist/client/env.mjs?x=1` })
    })

    it('reaches a root reported by a symlink\'s real path, not the project\'s own textual path to it', () => {
      // What Vite actually sends when node_modules is a symlink (this
      // project's own parallel-worktree pattern): the caller resolves each
      // root to its real path before handing it here, so the comparison
      // still lines up even though it no longer looks like a subpath of ROOT.
      const realNodeModules = '/home/user/some-other-checkout/node_modules'
      expect(routeInternalRequest(`orivon://settings/@fs${realNodeModules}/vite/dist/client/env.mjs`, true, [`${ROOT}/src`, realNodeModules]))
        .toEqual({ kind: 'dev', path: `/@fs${realNodeModules}/vite/dist/client/env.mjs` })
    })

    it('holds a differently cased `/@FS/` to the same roots', () => {
      for (const url of ['orivon://settings/@FS/etc/passwd', `orivon://settings/@Fs${ROOT}/package.json`]) {
        expect(routeInternalRequest(url, true, ROOTS)).toEqual({ kind: 'not-found' })
      }
    })

    it('never reaches a file outside them, however plainly named', () => {
      for (const url of [
        `orivon://settings/@fs${ROOT}/package.json`,
        'orivon://settings/@fs/etc/passwd',
        'orivon://settings/@fs/home/user/.ssh/id_rsa',
        // A sibling directory that merely starts with the same prefix as `src` is not inside it.
        `orivon://settings/@fs${ROOT}/src-evil/x.js`,
        `orivon://settings/@fs${ROOT}/node_modules-evil/x.js`,
        // The directory itself, not a file inside it.
        `orivon://settings/@fs${ROOT}/src`
      ]) {
        expect(routeInternalRequest(url, true, ROOTS), url).toEqual({ kind: 'not-found' })
      }
    })

    it('refuses every /@fs/ request when no roots are given, the safe default', () => {
      expect(routeInternalRequest(`orivon://settings/@fs${ROOT}/src/protocols/builtin.ts`, true)).toEqual({ kind: 'not-found' })
    })
  })
})
