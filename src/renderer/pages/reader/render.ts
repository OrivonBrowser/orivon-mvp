// Turns view.ts's nodes into elements. Text only ever goes in as a text node; the attributes come from the
// small fixed set view.ts writes, so nothing from an article reaches `innerHTML` or an event attribute.
import type { VNode } from './view.js'

const ALLOWED_ATTRS = new Set(['role', 'tabindex', 'title', 'data-block', 'class', 'aria-label', 'src', 'alt'])

export function renderNode (node: VNode, onLink: (index: number) => void): Node {
  if (node.tag === '#text') return document.createTextNode(node.text ?? '')
  const element = document.createElement(node.tag)
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (ALLOWED_ATTRS.has(name)) element.setAttribute(name, value)
  }
  if (node.link !== undefined) {
    const index = node.link
    element.addEventListener('click', (event) => { event.preventDefault(); onLink(index) })
    element.addEventListener('auxclick', (event) => { if (event.button === 1) { event.preventDefault(); onLink(index) } })
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); onLink(index) }
    })
  }
  for (const child of node.children ?? []) element.append(renderNode(child, onLink))
  return element
}
