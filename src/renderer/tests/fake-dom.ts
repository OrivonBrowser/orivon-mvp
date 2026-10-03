// A node-only stand-in for the parts of the DOM the tab strip and its decorators touch: a tree of elements with
// classes, attributes, a dataset, listeners and the insert/remove calls, and a count of how many times an element
// was put into a parent. Unit tests run without a DOM (docs/development/testing.md), so a test of code that keeps
// elements alive across updates needs a tree whose elements can be told apart.

export class FakeNode {
  parent: FakeNode | null = null
  kids: FakeNode[] = []
  attrs = new Map<string, string>()
  dataset: Record<string, string> = {}
  classes = new Set<string>()
  listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
  style = {
    props: new Map<string, string>(),
    setProperty: (name: string, value: string): void => { this.style.props.set(name, value) },
    getPropertyValue: (name: string): string => this.style.props.get(name) ?? ''
  }

  classList = {
    add: (...names: string[]): void => { for (const name of names) this.classes.add(name) },
    remove: (...names: string[]): void => { for (const name of names) this.classes.delete(name) },
    toggle: (name: string, force?: boolean): void => { if (force ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name) },
    contains: (name: string): boolean => this.classes.has(name)
  }

  text = ''
  hidden = false
  tabIndex = 0
  type = ''
  scrollLeft = 0
  scrollWidth = 0
  clientWidth = 0
  /** How many times this element was inserted into a parent (appended, put before another, or moved). */
  insertions = 0

  constructor (readonly tag: string) {}

  get className (): string { return [...this.classes].join(' ') }
  set className (value: string) { this.classes = new Set(value.split(' ').filter((name) => name !== '')) }
  get title (): string { return this.attrs.get('title') ?? '' }
  set title (value: string) { this.attrs.set('title', value) }
  get children (): FakeNode[] { return [...this.kids] }
  get childElementCount (): number { return this.kids.length }
  get parentElement (): FakeNode | null { return this.parent }
  get nextElementSibling (): FakeNode | null {
    if (this.parent === null) return null
    return this.parent.kids[this.parent.kids.indexOf(this) + 1] ?? null
  }

  get textContent (): string { return this.kids.length > 0 ? this.kids.map((kid) => kid.textContent).join('') : this.text }
  set textContent (value: string) {
    this.replaceChildren()
    this.text = value
  }

  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
  getAttribute (name: string): string | null { return this.attrs.get(name) ?? null }
  removeAttribute (name: string): void { this.attrs.delete(name) }

  addEventListener (type: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  /** Runs the listeners of `type` the way the browser would for an event aimed at this element. */
  fire (type: string, init: Record<string, unknown> = {}): void {
    const event = { stopPropagation: () => {}, preventDefault: () => {}, button: 0, ...init }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  private detach (): void {
    if (this.parent === null) return
    this.parent.kids.splice(this.parent.kids.indexOf(this), 1)
    this.parent = null
  }

  append (...nodes: FakeNode[]): void {
    for (const node of nodes) this.insertBefore(node, null)
  }

  insertBefore (node: FakeNode, ref: FakeNode | null): void {
    node.detach()
    const at = ref === null ? this.kids.length : this.kids.indexOf(ref)
    this.kids.splice(at, 0, node)
    node.parent = this
    node.insertions += 1
  }

  before (node: FakeNode): void { this.parent?.insertBefore(node, this) }

  remove (): void { this.detach() }

  replaceChildren (...nodes: FakeNode[]): void {
    for (const kid of [...this.kids]) kid.detach()
    this.text = ''
    this.append(...nodes)
  }

  querySelectorAll (selector: string): FakeNode[] {
    const wanted = selector.slice(1)
    const found: FakeNode[] = []
    const walk = (node: FakeNode): void => {
      for (const kid of node.kids) {
        if (kid.classes.has(wanted) || (selector.startsWith('#') && kid.attrs.get('id') === wanted)) found.push(kid)
        walk(kid)
      }
    }
    walk(this)
    return found
  }

  querySelector (selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] ?? null }
  scrollIntoView (): void {}
  getBoundingClientRect (): { left: number, right: number, height: number } { return { left: 0, right: 0, height: 36 } }
}

export function fakeDocument (): { row: FakeNode, scroller: FakeNode, newTab: FakeNode, created: FakeNode[] } & { document: object } {
  const row = new FakeNode('div')
  const scroller = new FakeNode('div')
  const newTab = new FakeNode('button')
  row.attrs.set('id', 'tabrow')
  scroller.attrs.set('id', 'tab-scroll')
  newTab.attrs.set('id', 'new-tab')
  row.append(scroller, newTab)
  const created: FakeNode[] = []
  const document = {
    querySelector: (selector: string) => ({ '#tabrow': row, '#tab-scroll': scroller, '#new-tab': newTab })[selector] ?? null,
    createElement: (tag: string) => {
      const node = new FakeNode(tag)
      created.push(node)
      return node
    }
  }
  return { row, scroller, newTab, created, document }
}
