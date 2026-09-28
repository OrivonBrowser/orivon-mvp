// A routed XMLHttpRequest's received bytes, and every `responseType` view
// of them the XHR spec defines. `installXhrResponse` is SERIALISED into the
// main world (see ./wire.ts's header) and publishes `xhrBodies` on
// the shared slot for ./xhr.ts.
import type { FetchRouteTarget, RoutedSlot, XhrBody } from './types.js'

export function installXhrResponse (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]
  if (slot === undefined) return

  function essence (mime: string): string {
    return (mime.split(';')[0] ?? '').trim().toLowerCase()
  }

  function charsetOf (mime: string): string | undefined {
    return /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(mime)?.[1]
  }

  function decoderFor (label: string | undefined): TextDecoder {
    try { return new TextDecoder(label ?? 'utf-8') } catch { return new TextDecoder('utf-8') }
  }

  function isXml (type: string): boolean {
    return type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml')
  }

  /** `mime` is the final MIME type: the overridden one if the page called overrideMimeType, else the response's own. */
  function create (mime: string): XhrBody {
    const chunks: Uint8Array[] = []
    let received = 0
    // Streaming decode, so responseText during LOADING costs only the new bytes.
    const textDecoder = decoderFor(charsetOf(mime))
    let text = ''
    let textDone = false
    const cache = new Map<string, unknown>()

    function all (): Uint8Array<ArrayBuffer> {
      const out = new Uint8Array(received)
      let at = 0
      for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
      return out
    }

    function fullText (): string {
      if (!textDone) { text += textDecoder.decode(); textDone = true }
      return text
    }

    function parse (forResponseXml: boolean): unknown {
      const type = essence(mime)
      const html = type === 'text/html'
      // responseXML with responseType '' parses XML only; 'document' parses HTML too.
      if (!(isXml(type) || (html && !forResponseXml)) || typeof DOMParser !== 'function') return null
      const parserType = html ? 'text/html' : ['text/xml', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'].includes(type) ? type : 'application/xml'
      const doc = new DOMParser().parseFromString(fullText(), parserType as DOMParserSupportedType)
      return doc.getElementsByTagName('parsererror').length > 0 && !html ? null : doc
    }

    return {
      get received () { return received },
      push (chunk) {
        chunks.push(chunk)
        received += chunk.byteLength
        text += textDecoder.decode(chunk, { stream: true })
      },
      text: () => text,
      value (type) {
        if (cache.has(type)) return cache.get(type)
        let value: unknown
        if (type === 'arraybuffer') value = all().buffer
        else if (type === 'blob') value = new Blob([all()], { type: mime })
        else if (type === 'json') {
          try { value = JSON.parse(new TextDecoder('utf-8').decode(all())) } catch { value = null }
        } else if (type === 'document') value = parse(false)
        else value = fullText()
        cache.set(type, value)
        return value
      },
      document (forResponseXml) {
        const key = forResponseXml ? 'responseXML' : 'document'
        if (!cache.has(key)) cache.set(key, parse(forResponseXml))
        return cache.get(key)
      }
    }
  }

  slot.xhrBodies = { create }
}
