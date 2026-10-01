// Turns the cleaned article a page-side extraction produced into plain blocks. The function is sent to the
// page's isolated world as source text (Function.prototype.toString), so it must stay self-contained: it names
// nothing outside itself. What it returns is still untrusted until reader-blocks.ts has checked it.

export interface WalkNode {
  readonly nodeType: number
  readonly nodeName: string
  readonly textContent: string | null
  readonly childNodes: ArrayLike<WalkNode>
  getAttribute: (name: string) => string | null
}

export type RawInline = string | { t: string, href?: string, c: RawInline[] }
export interface RawBlock { t: string, c?: RawInline[], text?: string, ordered?: boolean, items?: RawInline[][], src?: string, alt?: string, caption?: string, rows?: string[][] }

export function walkReaderContent (root: WalkNode, limit: number): RawBlock[] {
  const out: RawBlock[] = []
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'TEMPLATE', 'NAV', 'ASIDE']
  const BLOCKS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'FIGURE', 'IMG', 'PICTURE', 'TABLE', 'HR', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'DL', 'DD', 'DT', 'LI', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'ADDRESS', 'FIELDSET']
  const KINDS: Record<string, string> = { EM: 'em', I: 'em', CITE: 'em', STRONG: 'strong', B: 'strong', CODE: 'code', KBD: 'code', SAMP: 'code', TT: 'code' }

  const tag = (node: WalkNode): string => node.nodeName.toUpperCase()
  const children = (node: WalkNode): WalkNode[] => Array.prototype.slice.call(node.childNodes) as WalkNode[]
  const isBlockElement = (node: WalkNode): boolean => node.nodeType === 1 && BLOCKS.includes(tag(node))

  function inline (nodes: WalkNode[]): RawInline[] {
    const result: RawInline[] = []
    for (const node of nodes) {
      if (node.nodeType === 3) {
        result.push((node.textContent ?? '').replace(/\s+/g, ' '))
      } else if (node.nodeType === 1 && !SKIP.includes(tag(node))) {
        const name = tag(node)
        if (name === 'BR') result.push(' ')
        else if (name === 'A') result.push({ t: 'a', href: node.getAttribute('href') ?? '', c: inline(children(node)) })
        else if (name === 'IMG') continue
        else if (KINDS[name] !== undefined) result.push({ t: KINDS[name] as string, c: inline(children(node)) })
        else result.push(...inline(children(node)))
      }
    }
    return result
  }

  /** Collapses the blanks at both ends of a run, which the page's own markup put there. */
  function trimmed (items: RawInline[]): RawInline[] {
    const copy = items.slice()
    const first = copy[0]
    if (typeof first === 'string') copy[0] = first.replace(/^\s+/, '')
    const last = copy[copy.length - 1]
    if (typeof last === 'string') copy[copy.length - 1] = last.replace(/\s+$/, '')
    return copy
  }

  const add = (entry: RawBlock): void => { if (out.length < limit) out.push(entry) }

  function image (node: WalkNode, caption: string): void {
    const src = node.getAttribute('src') ?? ''
    if (src !== '') add({ t: 'img', src, alt: node.getAttribute('alt') ?? '', caption })
  }

  function findFirst (node: WalkNode, name: string): WalkNode | null {
    for (const child of children(node)) {
      if (child.nodeType !== 1) continue
      if (tag(child) === name) return child
      const deeper = findFirst(child, name)
      if (deeper !== null) return deeper
    }
    return null
  }

  function list (node: WalkNode): void {
    const items: RawInline[][] = []
    const collect = (parent: WalkNode): void => {
      for (const li of children(parent)) {
        if (li.nodeType !== 1 || tag(li) !== 'LI') continue
        const own = children(li).filter((child) => !(child.nodeType === 1 && (tag(child) === 'UL' || tag(child) === 'OL')))
        items.push(trimmed(inline(own)))
        for (const nested of children(li)) if (nested.nodeType === 1 && (tag(nested) === 'UL' || tag(nested) === 'OL')) collect(nested)
      }
    }
    collect(node)
    add({ t: 'list', ordered: tag(node) === 'OL', items })
  }

  function table (node: WalkNode): void {
    const rows: string[][] = []
    const visit = (parent: WalkNode): void => {
      for (const child of children(parent)) {
        if (child.nodeType !== 1) continue
        const name = tag(child)
        if (name === 'TR') {
          rows.push(children(child).filter((c) => c.nodeType === 1 && (tag(c) === 'TD' || tag(c) === 'TH')).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()))
        } else if (name === 'THEAD' || name === 'TBODY' || name === 'TFOOT') {
          visit(child)
        }
      }
    }
    visit(node)
    add({ t: 'table', rows })
  }

  /** A run of inline nodes between block elements becomes one paragraph. */
  function flush (run: WalkNode[], type: string): void {
    if (run.length === 0) return
    add({ t: type, c: trimmed(inline(run)) })
    run.length = 0
  }

  function visit (parent: WalkNode, type: string): void {
    const run: WalkNode[] = []
    for (const node of children(parent)) {
      if (out.length >= limit) return
      if (!isBlockElement(node)) {
        if (node.nodeType === 3 || (node.nodeType === 1 && !SKIP.includes(tag(node)))) run.push(node)
        continue
      }
      flush(run, type)
      const name = tag(node)
      if (name === 'P' || name === 'LI' || name === 'DD' || name === 'DT' || name === 'FIGCAPTION' || name === 'SUMMARY' || name === 'ADDRESS') {
        // A paragraph may hold a picture: it is shown first, the text after it.
        const picture = findFirst(node, 'IMG')
        if (picture !== null && (node.textContent ?? '').trim() === '') image(picture, '')
        else visit(node, type)
      } else if (name === 'H1' || name === 'H2') {
        add({ t: 'h2', c: trimmed(inline(children(node))) })
      } else if (/^H[3-6]$/.test(name)) {
        add({ t: 'h3', c: trimmed(inline(children(node))) })
      } else if (name === 'BLOCKQUOTE') {
        visit(node, 'quote')
      } else if (name === 'PRE') {
        add({ t: 'pre', text: node.textContent ?? '' })
      } else if (name === 'UL' || name === 'OL') {
        list(node)
      } else if (name === 'IMG') {
        image(node, '')
      } else if (name === 'PICTURE') {
        const picture = findFirst(node, 'IMG')
        if (picture !== null) image(picture, '')
      } else if (name === 'FIGURE') {
        const picture = findFirst(node, 'IMG')
        const caption = findFirst(node, 'FIGCAPTION')
        if (picture !== null) image(picture, (caption?.textContent ?? '').replace(/\s+/g, ' ').trim())
        else visit(node, type)
      } else if (name === 'TABLE') {
        table(node)
      } else if (name === 'HR') {
        add({ t: 'hr' })
      } else {
        visit(node, type)
      }
    }
    flush(run, type)
  }

  visit(root, 'p')
  return out
}
