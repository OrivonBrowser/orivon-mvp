// A small typed element builder, so a page assembles its DOM in code without a
// framework. Text goes in as a text node, never as HTML.

type Child = Node | string | null | undefined | false

/** `props` are assigned to the element as properties (className, id,
 * disabled, onclick, ...). */
export function h<K extends keyof HTMLElementTagNameMap> (
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (props !== null) Object.assign(element, props)
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    element.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return element
}

/** Replaces everything inside `parent`. */
export function replaceChildren (parent: Element, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false))
}
