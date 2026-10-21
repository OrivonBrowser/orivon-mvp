// A ported Electron app builds `'file://' + path` for its own files and hands it to an `<audio>`,
// `<img>` or `<video>`; its page was a `file:` page, so the URL loaded. Here the page is an http(s)
// page and Chromium refuses a `file:` URL before a request leaves, so a `file:` URL under the virtual
// root is rewritten to the root-absolute path the app's origin answers from the app's own files
// (ADR-0070). Any other `file:` URL is left alone and fails as it does in any web page.

import { USER_DATA_PATH } from './app.js'

const FILE_ROOT = `file://${USER_DATA_PATH}/`

/** `/orivon/app/<path>` for a `file:///orivon/app/<path>` URL, and `value` itself for anything else. */
export function rewriteAppFileUrl (value: string): string {
  return value.startsWith(FILE_ROOT) ? value.slice('file://'.length) : value
}

type Setter = (this: unknown, value: unknown) => void
type SetAttribute = (this: unknown, name: string, value: string) => void
interface ElementClass { readonly prototype: object }
type AudioConstructor = new (src?: string) => object

/** The globals the rewrite patches; a page has them all, and a test builds the ones it needs. */
export interface FileUrlScope {
  HTMLMediaElement?: ElementClass
  HTMLImageElement?: ElementClass
  HTMLSourceElement?: ElementClass
  Audio?: AudioConstructor
}

const installed = new WeakSet<object>()

/**
 * Patches the entry points an app sets a media or image address through: the `src` property of
 * `<audio>`, `<video>`, `<img>` and `<source>`, `setAttribute('src', ...)` on them, and `new Audio(src)`.
 * Idempotent per scope. Markup an app parses (`innerHTML`) and CSS `url(file://...)` are not rewritten.
 */
export function installFileUrlRewrite (scope: FileUrlScope): void {
  if (installed.has(scope)) return
  installed.add(scope)
  for (const element of [scope.HTMLMediaElement, scope.HTMLImageElement, scope.HTMLSourceElement]) {
    if (element !== undefined) patchElement(element.prototype)
  }
  if (scope.Audio !== undefined) scope.Audio = rewritingAudio(scope.Audio)
}

function patchElement (prototype: object): void {
  const src = Object.getOwnPropertyDescriptor(prototype, 'src')
  const set = src?.set as Setter | undefined
  if (src !== undefined && set !== undefined) {
    Object.defineProperty(prototype, 'src', { ...src, set (value: unknown) { set.call(this, rewriteAppFileUrl(String(value))) } })
  }
  const setAttribute = (prototype as { setAttribute?: SetAttribute }).setAttribute
  if (typeof setAttribute === 'function') {
    Object.defineProperty(prototype, 'setAttribute', {
      configurable: true,
      writable: true,
      value: function (this: unknown, name: string, value: string): void {
        setAttribute.call(this, name, String(name).toLowerCase() === 'src' ? rewriteAppFileUrl(String(value)) : value)
      }
    })
  }
}

/** `Audio` with the same prototype, so `instanceof` and subclassing hold, whose address goes through the patched `src`. */
function rewritingAudio (Original: AudioConstructor): AudioConstructor {
  function RewritingAudio (this: unknown, src?: string): object {
    const audio = Reflect.construct(Original, [], new.target ?? RewritingAudio) as { src: string }
    if (src !== undefined) audio.src = String(src)
    return audio
  }
  RewritingAudio.prototype = Original.prototype
  return RewritingAudio as unknown as AudioConstructor
}
