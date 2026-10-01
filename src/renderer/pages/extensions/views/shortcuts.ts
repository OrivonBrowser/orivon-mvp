// The Keyboard shortcuts view: one card per extension that declares commands,
// one row per command with its key, and the control that records a new one.
// The next key press is read in main and comes back as an event; this view
// draws the outcome and never interprets a keystroke.
import { internalBridge } from '../../shared/bridge.js'
import { h, replaceChildren } from '../../shared/dom.js'
import { closeIcon, keyboardIcon, pencilIcon, puzzleIcon } from '../../shared/icons.js'
import { letterTile } from '../../shared/letter-tile.js'
import type { ExtensionView, PageContext } from '../types.js'
import { describeCommand, noticeFor, rowKey } from './shortcuts-model.js'
import type { CommandRow, ExtensionGroup, Notice, Recorded, ShortcutsReply } from './shortcuts-model.js'

const STORE = 'https://chromewebstore.google.com/category/extensions'
const EXTENSION_ID = /^[a-p]{32}$/

let data: ShortcutsReply | null = null
let listening: string | null = null
const notices = new Map<string, Notice>()
let focusRow: string | null = null
let outlined = ''
let latest: { root: HTMLElement, ctx: PageContext } | null = null
let wired = false

function labelled<T extends HTMLElement> (element: T, label: string): T {
  element.setAttribute('aria-label', label)
  element.title = label
  return element
}

function caps (keys: readonly string[]): HTMLElement {
  return h('span', { className: 'sc-keys' }, ...keys.map((key) => h('kbd', { textContent: key })))
}

const here = (): boolean => location.pathname.startsWith('/shortcuts')

function redraw (): void {
  if (latest !== null && data !== null && here()) draw(latest.root, latest.ctx, data)
}

function startListening (ctx: PageContext, id: string, command: CommandRow): void {
  const key = rowKey(id, command.name)
  notices.clear()
  listening = key
  redraw()
  void ctx.request<boolean>('shortcuts.record', { id, name: command.name }).then((started) => {
    if (!started && listening === key) { listening = null; redraw() }
  })
}

function stopListening (ctx: PageContext): void {
  if (listening === null) return
  listening = null
  redraw()
  void ctx.request('shortcuts.cancel')
}

function control (group: ExtensionGroup, command: CommandRow, ctx: PageContext): HTMLElement {
  const key = rowKey(group.id, command.name)
  const what = describeCommand(command) ?? command.name
  if (listening === key) {
    return h('div', { className: 'sc-control sc-recording' },
      h('span', { className: 'sc-field', role: 'status', textContent: 'Press a shortcut' }),
      h('button', { className: 'link-btn', type: 'button', textContent: 'Cancel', onclick: () => { stopListening(ctx) } }))
  }
  const change = labelled(h('button', { className: 'btn icon sc-change', type: 'button', onclick: () => { startListening(ctx, group.id, command) } }, pencilIcon()), `Change shortcut for ${what}`)
  // Keeps the pencils in one column down the card, set or not.
  const remove = command.keys === null
    ? h('span', { className: 'sc-slot' })
    : labelled(h('button', {
      className: 'btn icon sc-remove',
      type: 'button',
      onclick: () => { focusRow = key; void ctx.request('shortcuts.clear', { id: group.id, name: command.name }).then(ctx.refresh) }
    }, closeIcon()), `Remove shortcut for ${what}`)
  return h('div', { className: 'sc-control' },
    command.keys === null ? h('span', { className: 'muted', textContent: 'Not set' }) : caps(command.keys),
    change,
    remove)
}

function noticeBox (group: ExtensionGroup, command: CommandRow, notice: Notice, ctx: PageContext): HTMLElement {
  const { action } = notice
  const act = action === undefined
    ? null
    : h('button', {
      className: action.small ? 'btn small' : 'link-btn',
      type: 'button',
      textContent: action.label,
      onclick: () => {
        if (action.kind === 'settings') {
          void internalBridge().request('pages', { type: 'open', page: 'settings', path: '/shortcuts' })
          return
        }
        const key = rowKey(group.id, command.name)
        void ctx.request('shortcuts.move', { id: group.id, name: command.name, binding: action.binding }).then(() => {
          notices.delete(key)
          focusRow = key
          ctx.refresh()
        })
      }
    })
  return h('div', { className: 'banner warn sc-notice', role: 'status' }, h('span', { textContent: notice.text }), act)
}

function row (group: ExtensionGroup, command: CommandRow, ctx: PageContext): HTMLElement {
  const key = rowKey(group.id, command.name)
  const what = describeCommand(command)
  const notice = notices.get(key)
  const li = h('li', { className: 'sc-row' },
    h('div', { className: 'sc-main' },
      what === null ? h('code', { textContent: command.name }) : h('span', { className: 'sc-desc', textContent: what }),
      command.keys === null && command.suggestedKeys !== null
        ? h('span', { className: 'muted sc-hint', textContent: `Suggested: ${command.suggestedKeys.join('+')} (already in use)` })
        : null,
      command.unavailable === null ? null : h('span', { className: 'muted sc-hint', textContent: command.unavailable })),
    control(group, command, ctx),
    notice === undefined ? null : noticeBox(group, command, notice, ctx))
  li.dataset['row'] = key
  return li
}

function card (group: ExtensionGroup, ctx: PageContext): HTMLElement {
  const icon = group.iconDataUrl === undefined
    ? letterTile(group.name, 'sc-icon')
    : h('img', { className: 'sc-icon', src: group.iconDataUrl, alt: '' })
  return h('section', { className: 'card sc-card', id: `sc-${group.id}` },
    h('h2', { className: 'sc-head' }, icon, h('span', { className: 'sc-name', textContent: group.name })),
    h('ul', { className: 'sc-rows' }, ...group.commands.map((command) => row(group, command, ctx))))
}

function emptyState (reply: ShortcutsReply): HTMLElement {
  return h('div', { className: 'empty-state' },
    keyboardIcon(),
    h('strong', { textContent: 'No shortcuts yet' }),
    h('p', { textContent: 'Shortcuts of the extensions you add appear here.' }),
    reply.installed > 0
      ? null
      : h('a', { className: 'link-btn', href: STORE, target: '_blank', rel: 'noopener', textContent: 'Get extensions from the Chrome Web Store' }))
}

function skeleton (): HTMLElement {
  const list = h('div', { className: 'sc-list' },
    ...[0, 1].map(() => h('div', { className: 'card sc-card' }, h('span', { className: 'skeleton line' }), h('span', { className: 'skeleton line short' }))))
  list.setAttribute('aria-busy', 'true')
  return list
}

/** Scrolls to the card the address names, once, and outlines it for a moment. */
function showTarget (root: HTMLElement): void {
  const id = location.hash.slice(1)
  if (!EXTENSION_ID.test(id) || outlined === id) return
  const target = root.querySelector<HTMLElement>(`#sc-${id}`)
  if (target === null) return
  outlined = id
  target.scrollIntoView({ block: 'center' })
  target.classList.add('target')
  setTimeout(() => { target.classList.remove('target') }, 1800)
}

function draw (root: HTMLElement, ctx: PageContext, reply: ShortcutsReply): void {
  replaceChildren(root, reply.extensions.length === 0
    ? emptyState(reply)
    : h('div', { className: 'sc-list' }, ...reply.extensions.map((group) => card(group, ctx))))
  showTarget(root)
  // Kept until the person does something else: the page redraws again when the new key reaches the list.
  if (focusRow !== null && listening === null) {
    const target = [...root.querySelectorAll<HTMLElement>('[data-row]')].find((element) => element.dataset['row'] === focusRow)
    target?.querySelector<HTMLElement>('.sc-change')?.focus()
  }
}

function wire (ctx: PageContext): void {
  if (wired) return
  wired = true
  // A reload may have left main waiting for a key from an earlier life of this page.
  void ctx.request('shortcuts.cancel')
  const forget = (): void => { focusRow = null }
  document.addEventListener('keydown', forget, true)
  document.addEventListener('pointerdown', forget, true)
  internalBridge().onEvent((topic, payload) => {
    if (topic !== 'extensions.shortcut-recorded' || data === null || latest === null || !here()) return
    const recorded = payload as Recorded
    const key = rowKey(recorded.extensionId, recorded.name)
    if (listening === key) listening = null
    focusRow = key
    const notice = noticeFor(recorded, data.extensions, data.platform)
    if (notice === null) notices.delete(key)
    else notices.set(key, notice)
    redraw()
  })
  // A click anywhere but the listening field gives the key back to the page.
  document.addEventListener('pointerdown', (event) => {
    if (listening === null || latest === null || !here()) return
    if (event.target instanceof Element && event.target.closest('.sc-recording') !== null) return
    stopListening(latest.ctx)
  })
}

export const shortcutsView: ExtensionView = {
  leave: () => {
    if (listening === null) return
    listening = null
    void internalBridge().request('extensions', { type: 'shortcuts.cancel' })
  },
  render: (root, ctx) => {
    wire(ctx)
    latest = { root, ctx }
    if (ctx.isPrivate) {
      replaceChildren(root, h('div', { className: 'banner info', role: 'status', textContent: 'Extensions do not run in private or guest windows.' }))
      return
    }
    if (root.childElementCount === 0 || data === null) replaceChildren(root, skeleton())
    void ctx.request<ShortcutsReply>('shortcuts.list').then((reply) => {
      data = reply
      draw(root, ctx, reply)
    })
  }
}
