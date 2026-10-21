import { describe, expect, it } from 'vitest'
import { installFileUrlRewrite, rewriteAppFileUrl } from '../file-urls.js'
import type { FileUrlScope } from '../file-urls.js'

describe('rewriteAppFileUrl', () => {
  it('turns a file URL under the virtual root into the root-absolute path the app origin answers', () => {
    expect(rewriteAppFileUrl('file:///orivon/app/webtorrent/static/sound/add.wav')).toBe('/orivon/app/webtorrent/static/sound/add.wav')
    expect(rewriteAppFileUrl('file:///orivon/app/a%20b.png')).toBe('/orivon/app/a%20b.png')
  })

  it('leaves every other address as it was', () => {
    for (const value of ['file:///etc/passwd', 'file:///orivon/application/x.png', 'file:///orivon/app', 'file://host/orivon/app/x', '/orivon/app/x.png', 'https://a.example/x.png', 'blob:https://a.example/1', 'data:audio/wav;base64,AAAA', '']) {
      expect([value, rewriteAppFileUrl(value)]).toEqual([value, value])
    }
  })
})

/** What a page's element classes do with `src`: remember it, as an attribute store would. */
function fakeElement (): { new (): { src: string, attributes: Map<string, string>, setAttribute: (name: string, value: string) => void } } {
  return class {
    attributes = new Map<string, string>()
    #src = ''
    get src (): string { return this.#src }
    set src (value: string) { this.#src = value }
    setAttribute (name: string, value: string): void { this.attributes.set(name, value) }
  }
}

function scopeWithEveryEntryPoint (): FileUrlScope & { Audio: new (src?: string) => { src: string } } {
  const Media = fakeElement()
  const Image = fakeElement()
  const Source = fakeElement()
  class Audio extends Media {
    preload = 'auto'
    constructor (src?: string) {
      super()
      if (src !== undefined) this.src = src
    }
  }
  return { HTMLMediaElement: Media, HTMLImageElement: Image, HTMLSourceElement: Source, Audio: Audio as unknown as new (src?: string) => { src: string } }
}

const FILE = 'file:///orivon/app/sound/add.wav'
const PATH = '/orivon/app/sound/add.wav'

describe('installFileUrlRewrite -- every entry point an app sets a media or image address through', () => {
  it.each(['HTMLMediaElement', 'HTMLImageElement', 'HTMLSourceElement'] as const)('rewrites the src property of %s', (name) => {
    const scope = scopeWithEveryEntryPoint()
    installFileUrlRewrite(scope)
    const element = new (scope[name] as unknown as new () => { src: string })()
    element.src = FILE
    expect(element.src).toBe(PATH)
    element.src = 'https://a.example/x.png'
    expect(element.src).toBe('https://a.example/x.png')
  })

  it.each(['HTMLMediaElement', 'HTMLImageElement', 'HTMLSourceElement'] as const)('rewrites setAttribute("src") on %s, and no other attribute', (name) => {
    const scope = scopeWithEveryEntryPoint()
    installFileUrlRewrite(scope)
    const element = new (scope[name] as unknown as new () => { attributes: Map<string, string>, setAttribute: (n: string, v: string) => void })()
    element.setAttribute('src', FILE)
    element.setAttribute('SRC', FILE)
    element.setAttribute('title', FILE)
    expect(element.attributes.get('src')).toBe(PATH)
    expect(element.attributes.get('SRC')).toBe(PATH)
    expect(element.attributes.get('title')).toBe(FILE)
  })

  it('rewrites the address given to new Audio(), and keeps Audio an HTMLMediaElement', () => {
    const scope = scopeWithEveryEntryPoint()
    const Original = scope.Audio
    installFileUrlRewrite(scope)
    const audio = new scope.Audio(FILE) as { src: string }
    expect(audio.src).toBe(PATH)
    expect(audio).toBeInstanceOf(Original)
    expect(audio).toBeInstanceOf(scope.HTMLMediaElement as unknown as new () => object)
    expect((audio as unknown as { preload: string }).preload).toBe('auto')
    expect((new scope.Audio() as { src: string }).src).toBe('')
  })

  it('installs once per scope, so a second import does not wrap the rewrite twice', () => {
    const scope = scopeWithEveryEntryPoint()
    installFileUrlRewrite(scope)
    const patched = Object.getOwnPropertyDescriptor(scope.HTMLMediaElement?.prototype, 'src')?.set
    installFileUrlRewrite(scope)
    expect(Object.getOwnPropertyDescriptor(scope.HTMLMediaElement?.prototype, 'src')?.set).toBe(patched)
  })

  it('tolerates a scope that lacks some classes', () => {
    expect(() => { installFileUrlRewrite({}) }).not.toThrow()
  })
})
