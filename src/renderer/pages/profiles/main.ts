// The Profiles page: every profile with its name and colour, and what can be done
// to it: open it (in a browser of its own), rename it, recolour it, delete it. A
// profile is a separate browser with its own bookmarks, history, permissions and
// apps, so this is also where a new one is made. A private window is started here too.
import { internalBridge } from '../shared/bridge.js'
import { h, replaceChildren } from '../shared/dom.js'

const bridge = internalBridge()

interface Row {
  readonly id: string
  readonly name: string
  readonly color: string
  readonly running: boolean
  readonly current: boolean
}
interface ListReply {
  readonly profiles: readonly Row[]
  readonly colors: readonly string[]
  readonly isPrivate: boolean
}
type Outcome = { readonly ok: true } | { readonly ok: false, readonly reason: string }

const REASONS: Readonly<Record<string, string>> = {
  'invalid-name': 'Give the profile a name of up to 40 characters.',
  'invalid-color': 'Choose one of the colours.',
  'unknown-profile': 'That profile is not there any more.',
  'default-profile': 'The default profile cannot be deleted.',
  running: 'That profile is open. Close its window first.',
  private: 'A private window does not change your profiles.',
  failed: 'That could not be done.'
}

let reply: ListReply = { profiles: [], colors: [], isPrivate: false }
let newColor = 'blue'
/** Kept across redraws: choosing a colour must not empty the box the person is typing in. */
let newName = ''
const list = h('div', { className: 'list' })
const problem = h('p', { className: 'problem', role: 'alert' })
const create = h('section', { className: 'create card' })

async function request (command: object): Promise<unknown> {
  return await bridge.request('profiles', command)
}

async function load (): Promise<void> {
  reply = await request({ type: 'list' }) as ListReply
  render()
}

async function act (command: object): Promise<void> {
  const outcome = await request(command) as Outcome | undefined
  problem.textContent = outcome?.ok === true ? '' : REASONS[(outcome as { reason?: string } | undefined)?.reason ?? 'failed'] ?? REASONS['failed'] ?? ''
  await load()
}

function swatches (selected: string, choose: (color: string) => void): HTMLElement {
  const buttons = reply.colors.map((color) => {
    const button = h('button', { className: color === selected ? 'swatch selected' : 'swatch', type: 'button', title: color, onclick: () => { choose(color) } }, h('span', { className: 'dot' }))
    button.dataset['color'] = color
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String(color === selected))
    button.setAttribute('aria-label', color)
    return button
  })
  return h('div', { className: 'swatches', role: 'radiogroup' }, ...buttons)
}

function card (row: Row): HTMLElement {
  const name = h('input', { className: 'text name', type: 'text', value: row.name, maxLength: 40, disabled: reply.isPrivate })
  name.setAttribute('aria-label', `Name of the profile ${row.name}`)
  name.addEventListener('change', () => { void act({ type: 'rename', id: row.id, name: name.value }) })
  const remove = h('button', { className: 'btn danger', type: 'button', textContent: 'Delete', disabled: reply.isPrivate || row.id === 'default' || row.current || row.running })
  let armed = false
  remove.addEventListener('click', () => {
    if (!armed) {
      armed = true
      remove.textContent = 'Click again to delete'
      remove.classList.add('armed')
      setTimeout(() => { armed = false; remove.textContent = 'Delete'; remove.classList.remove('armed') }, 4000)
      return
    }
    void act({ type: 'remove', id: row.id })
  })
  const status = row.current ? 'This window' : row.running ? 'Open' : ''
  const chip = h('span', { className: 'chip', textContent: row.name.slice(0, 1).toUpperCase() })
  chip.dataset['color'] = row.color
  return h('article', { className: 'card profile', id: `profile-${row.id}` },
    h('div', { className: 'head' }, chip, name, status === '' ? null : h('span', { className: 'status', textContent: status })),
    swatches(row.color, (color) => { if (!reply.isPrivate) void act({ type: 'color', id: row.id, color }) }),
    h('div', { className: 'actions' },
      h('button', { className: 'btn', type: 'button', textContent: row.running && !row.current ? 'Show' : 'Open', disabled: row.current && !reply.isPrivate, onclick: () => { void act({ type: 'open', id: row.id }) } }),
      remove))
}

function renderCreate (): void {
  const name = h('input', { className: 'text', type: 'text', placeholder: 'Name of the new profile', maxLength: 40, disabled: reply.isPrivate, value: newName })
  name.setAttribute('aria-label', 'Name of the new profile')
  name.addEventListener('input', () => { newName = name.value })
  const button = h('button', { className: 'btn primary', type: 'button', textContent: 'Create profile', disabled: reply.isPrivate })
  button.addEventListener('click', () => {
    void act({ type: 'create', name: name.value, color: newColor }).then(() => { newName = ''; renderCreate() })
  })
  replaceChildren(create,
    h('h2', { textContent: 'New profile' }),
    h('p', { className: 'help', textContent: 'A profile is a separate browser: its own bookmarks, history, permissions and apps. Nothing is shared between profiles.' }),
    h('div', { className: 'row' }, name, button),
    swatches(newColor, (color) => { newColor = color; renderCreate() }))
}

function render (): void {
  replaceChildren(list, ...reply.profiles.map(card))
  renderCreate()
}

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('header', { className: 'top' },
      h('h1', { textContent: 'Profiles' }),
      h('button', { className: 'btn', type: 'button', textContent: 'New private window', onclick: () => { void request({ type: 'newPrivate' }) } })),
    problem,
    list,
    create))

// Coming back to the tab shows who is open now.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load() })
void load()
