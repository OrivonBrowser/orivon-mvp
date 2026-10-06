import { describe, expect, it } from 'vitest'
import { reachableFiles, routeInternalRequest, routeShell, shellDetailsAllowed, shellRequestAllowed } from '../route.js'
import { DEFAULT_SESSION_ENTRIES, SHELL_SESSION_ENTRIES } from '../../shell/shell-session.js'

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

describe('routeShell', () => {
  const NEWTAB_FILES = new Set(['newtab/index.html', 'assets/newtab-a1.js', 'assets/newtab-a1.css', 'assets/shared-b2.js', 'assets/font-c3.woff2'])
  const ROUTE = (url: string, session: 'shell' | 'default', files: ReadonlySet<string> = NEWTAB_FILES): ReturnType<typeof routeShell> => routeShell(url, session, files)

  it('serves each entry in its own session only', () => {
    for (const entry of SHELL_SESSION_ENTRIES) {
      const file = entry === 'index' ? 'index.html' : `${entry}/index.html`
      expect(ROUTE(`orivon-shell://renderer/${file}`, 'shell')).toEqual({ kind: 'file', path: file, html: true })
      expect(ROUTE(`orivon-shell://renderer/${file}`, 'default')).toEqual({ kind: 'not-found' })
    }
    for (const entry of DEFAULT_SESSION_ENTRIES) {
      expect(ROUTE(`orivon-shell://renderer/${entry}/index.html`, 'default')).toEqual({ kind: 'file', path: `${entry}/index.html`, html: true })
      expect(ROUTE(`orivon-shell://renderer/${entry}/index.html`, 'shell')).toEqual({ kind: 'not-found' })
    }
  })

  it('serves every file under assets/ to the shell session, with a type it knows', () => {
    expect(ROUTE('orivon-shell://renderer/assets/x-1.js', 'shell')).toEqual({ kind: 'file', path: 'assets/x-1.js', html: false })
    expect(ROUTE('orivon-shell://renderer/assets/x-1.css', 'shell')).toEqual({ kind: 'file', path: 'assets/x-1.css', html: false })
    expect(ROUTE('orivon-shell://renderer/assets/font.woff2', 'shell')).toEqual({ kind: 'file', path: 'assets/font.woff2', html: false })
    for (const bad of ['x.html', 'x.json', 'x.js.map', 'noextension', 'x.node']) {
      expect(ROUTE(`orivon-shell://renderer/assets/${bad}`, 'shell'), bad).toEqual({ kind: 'not-found' })
    }
  })

  it('serves the default session only the files the new-tab page reaches', () => {
    expect(ROUTE('orivon-shell://renderer/assets/newtab-a1.js', 'default')).toEqual({ kind: 'file', path: 'assets/newtab-a1.js', html: false })
    expect(ROUTE('orivon-shell://renderer/assets/font-c3.woff2', 'default')).toEqual({ kind: 'file', path: 'assets/font-c3.woff2', html: false })
    expect(ROUTE('orivon-shell://renderer/assets/chrome-only-d4.js', 'default')).toEqual({ kind: 'not-found' })
    expect(routeShell('orivon-shell://renderer/assets/newtab-a1.js', 'default')).toEqual({ kind: 'not-found' })
  })

  it('refuses what is not a page or an asset of the build', () => {
    for (const url of [
      'orivon-shell://renderer/.vite/manifest.json',
      'orivon-shell://renderer/pages/settings/index.html',
      'orivon-shell://renderer/index.js',
      'orivon-shell://renderer/',
      'orivon-shell://renderer',
      'orivon-shell://renderer//index.html',
      'orivon-shell://renderer/assets//x.js',
      'orivon-shell://renderer/assets/..%2f..%2fpackage.json',
      'orivon-shell://renderer/assets/%2e%2e/%2e%2e/main/index.js',
      'orivon-shell://renderer/assets/%2E%2E%5C%2E%2E%5Cx.js',
      'orivon-shell://renderer/assets/%252e%252e/x.js',
      'orivon-shell://renderer/assets/a%00.js',
      'orivon-shell://renderer/assets/a\\b.js',
      'orivon-shell://other/index.html',
      'orivon-shell://renderer:8080/index.html',
      'orivon-shell://user@renderer/index.html',
      'orivon://renderer/index.html',
      'file:///index.html',
      'https://renderer/index.html',
      'not a url',
      ''
    ]) {
      expect(ROUTE(url, 'shell'), url).toEqual({ kind: 'not-found' })
      expect(ROUTE(url, 'default'), url).toEqual({ kind: 'not-found' })
    }
  })

  it('reads the same file whatever the query or fragment says', () => {
    expect(ROUTE('orivon-shell://renderer/overlay/index.html?overlay=menu&surface=menu', 'shell')).toEqual({ kind: 'file', path: 'overlay/index.html', html: true })
    expect(ROUTE('orivon-shell://renderer/index.html#x', 'shell')).toEqual({ kind: 'file', path: 'index.html', html: true })
  })
})

describe('reachableFiles', () => {
  const manifest = {
    'newtab/index.html': { file: 'newtab/index.html', isEntry: true, src: 'newtab/index.html', imports: ['_shared.js'], css: ['assets/newtab.css'], assets: ['assets/logo.png'] },
    '_shared.js': { file: 'assets/shared.js', imports: ['_leaf.js'], dynamicImports: ['lazy.js'] },
    '_leaf.js': { file: 'assets/leaf.js', css: ['assets/leaf.css'] },
    'lazy.js': { file: 'assets/lazy.js' },
    'index.html': { file: 'index.html', isEntry: true, imports: ['_chrome.js'] },
    '_chrome.js': { file: 'assets/chrome.js' }
  }

  it('names the entry, what it imports through any depth, and its styles and assets', () => {
    expect([...reachableFiles(manifest, 'newtab/index.html')].sort()).toEqual([
      'assets/lazy.js', 'assets/leaf.css', 'assets/leaf.js', 'assets/logo.png', 'assets/newtab.css', 'assets/shared.js', 'newtab/index.html'
    ])
  })

  it('leaves out what only another entry reaches', () => {
    expect(reachableFiles(manifest, 'newtab/index.html').has('assets/chrome.js')).toBe(false)
  })

  it('terminates on an import cycle and names nothing for an unknown entry', () => {
    const loop = { a: { file: 'assets/a.js', imports: ['b'] }, b: { file: 'assets/b.js', imports: ['a'] } }
    expect([...reachableFiles(loop, 'a')].sort()).toEqual(['assets/a.js', 'assets/b.js'])
    expect(reachableFiles(manifest, 'missing').size).toBe(0)
  })
})

describe('shellRequestAllowed', () => {
  const DASHBOARD = 'orivon-shell://renderer/newtab/index.html'
  const from = (url: string, isTopFrame = true): { url: string, isTopFrame: boolean } => ({ url, isTopFrame })

  it('lets the new-tab page load its own files, with or without a query', () => {
    for (const resourceType of ['script', 'stylesheet', 'image', 'font', 'xhr']) {
      expect(shellRequestAllowed({ resourceType, frame: from(DASHBOARD) }), resourceType).toBe(true)
      expect(shellRequestAllowed({ resourceType, frame: from(`${DASHBOARD}?q=1#x`) }), resourceType).toBe(true)
    }
  })

  it('lets a tab navigate to the page, which is how it loads and how Back returns to it', () => {
    expect(shellRequestAllowed({ resourceType: 'mainFrame', frame: from('https://a.example/') })).toBe(true)
    expect(shellRequestAllowed({ resourceType: 'mainFrame', frame: null })).toBe(true)
  })

  it('stops every other page, extension page or frame from loading anything of the scheme', () => {
    for (const resourceType of ['script', 'stylesheet', 'image', 'subFrame', 'xhr', 'media', 'font', 'webSocket', 'other']) {
      expect(shellRequestAllowed({ resourceType, frame: from('https://a.example/') }), resourceType).toBe(false)
      expect(shellRequestAllowed({ resourceType, frame: from('chrome-extension://abc/page.html') }), resourceType).toBe(false)
      expect(shellRequestAllowed({ resourceType, frame: from('') }), resourceType).toBe(false)
      expect(shellRequestAllowed({ resourceType, frame: null }), resourceType).toBe(false)
    }
  })

  it('stops a frame inside the new-tab page and a page that only names it in its path or query', () => {
    expect(shellRequestAllowed({ resourceType: 'script', frame: from(DASHBOARD, false) })).toBe(false)
    expect(shellRequestAllowed({ resourceType: 'script', frame: from('https://a.example/?u=orivon-shell://renderer/newtab/index.html') })).toBe(false)
    expect(shellRequestAllowed({ resourceType: 'script', frame: from('orivon-shell://renderer/index.html') })).toBe(false)
  })
})

describe('shellDetailsAllowed', () => {
  const DASHBOARD = 'orivon-shell://renderer/newtab/index.html'

  it('reads a frame as Electron gives it: the top frame has no parent', () => {
    expect(shellDetailsAllowed({ resourceType: 'script', frame: { url: DASHBOARD, parent: null } })).toBe(true)
    expect(shellDetailsAllowed({ resourceType: 'script', frame: { url: DASHBOARD, parent: {} } })).toBe(false)
    expect(shellDetailsAllowed({ resourceType: 'script' })).toBe(false)
  })

  it('refuses a request whose frame cannot be read', () => {
    const gone = { resourceType: 'image', get frame (): never { throw new Error('Render frame was disposed') } }
    expect(shellDetailsAllowed(gone)).toBe(false)
    const noUrl = { resourceType: 'image', frame: { get url (): string { throw new Error('gone') }, parent: null } }
    expect(shellDetailsAllowed(noUrl)).toBe(false)
    const noParent = { resourceType: 'mainFrame', frame: { url: DASHBOARD, get parent (): never { throw new Error('gone') } } }
    expect(shellDetailsAllowed(noParent)).toBe(false)
  })
})
