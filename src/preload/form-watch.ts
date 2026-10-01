// The page-side half of saving and filling passwords. It runs in the isolated world, exposes nothing to the
// page and stays inert until main says the vault can keep logins and the person has the feature on. It
// reports what a person does (which fields a page has, which one they focused, a submitted sign-in) and
// writes into the page's own fields the account the person chose in Orivon's chooser. A page can neither
// ask it for a value nor trigger a fill: the only way in is main's message on FORM_FILL_CHANNEL.
import { ipcRenderer } from 'electron'
import { FORM_FILL_CHANNEL, FORM_WATCH_CHANNEL } from '../main/channels.js'
import { choosePassword, chooseUsername, isRevealControl, isSignUp, isVisibleBox } from './login-fields.js'
import type { FieldInfo } from './login-fields.js'

interface Config { enabled: boolean, save: boolean, autofill: boolean }
interface FillCommand { type: 'fill', username: string | null, password: string, both: boolean }

/** Field changes are reported at most this often, so a page that rewrites its DOM all the time stays cheap. */
const OBSERVE_THROTTLE_MS = 500
/** The same credential is reported once within this time: a click and the submit it causes are one sign-in. */
const DUPLICATE_MS = 3000
const SUBMIT_LIKE = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function infoOf (input: HTMLInputElement): FieldInfo {
  const style = getComputedStyle(input)
  return {
    type: input.type,
    autocomplete: input.getAttribute('autocomplete') ?? '',
    value: input.value,
    disabled: input.disabled,
    readOnly: input.readOnly,
    visible: isVisibleBox(input.getBoundingClientRect(), style)
  }
}

const usable = (input: HTMLInputElement): boolean => {
  const info = infoOf(input)
  return info.visible && !info.disabled
}

const passwordInputs = (): HTMLInputElement[] =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable)

/** The form a password field belongs to, or, without one, the nearest ancestor that also holds another text box. */
function scopeOf (password: HTMLInputElement): Element {
  const form = password.form ?? password.closest('form')
  if (form !== null) return form
  let node: Element = password
  for (let depth = 0; depth < 6 && node.parentElement !== null; depth++) {
    node = node.parentElement
    if (node.querySelector('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])') !== null) return node
  }
  return password.parentElement ?? password
}

function usernameOf (password: HTMLInputElement): HTMLInputElement | null {
  const inputs = [...scopeOf(password).querySelectorAll<HTMLInputElement>('input')]
  const before = inputs.slice(0, inputs.indexOf(password))
  const index = chooseUsername(before.map(infoOf))
  return index === -1 ? null : before[index] ?? null
}

const passwordsOf = (scope: Element): HTMLInputElement[] =>
  [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable)

const rectOf = (input: HTMLInputElement): { x: number, y: number, width: number, height: number } => {
  const { x, y, width, height } = input.getBoundingClientRect()
  return { x, y, width, height }
}

/** Writes through the prototype's own setter and then fires the events a typed value would, so a framework that tracks the field sees it. */
function setValue (input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) return
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export function installFormWatch (): void {
  if (typeof document === 'undefined') return
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return
  if (window.top !== window) return

  let config: Config = { enabled: false, save: false, autofill: false }
  let observer: MutationObserver | undefined
  let throttle: ReturnType<typeof setTimeout> | undefined
  let lastFields = ''
  let lastPassword: HTMLInputElement | null = null
  /** A focus message went out and no blur has followed: main may be showing its chooser under that box. */
  let focusReported = false
  let lastSent: { key: string, at: number } | undefined

  const send = (message: Record<string, unknown>): void => { ipcRenderer.send(FORM_WATCH_CHANNEL, message) }

  function reportFields (): void {
    if (!config.enabled) return
    const passwords = passwordInputs()
    const signUp = isSignUp(passwords.map(infoOf))
    const key = `${String(passwords.length > 0)}:${String(signUp)}`
    if (key === lastFields) return
    lastFields = key
    send({ type: 'fields', hasPassword: passwords.length > 0, signUp })
  }

  function schedule (): void {
    if (throttle !== undefined) return
    throttle = setTimeout(() => { throttle = undefined; reportFields() }, OBSERVE_THROTTLE_MS)
  }

  function activate (): void {
    if (observer === undefined) {
      observer = new MutationObserver(schedule)
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] })
    }
    reportFields()
  }

  function deactivate (): void {
    observer?.disconnect()
    observer = undefined
    lastFields = ''
  }

  /** The password of a form and the username beside it, or null when no field of it has a value. */
  function credentialIn (passwords: HTMLInputElement[]): { username: string, password: string } | null {
    const at = choosePassword(passwords.map(infoOf))
    const field = at === -1 ? undefined : passwords[at]
    if (field === undefined || field.value === '') return null
    return { username: usernameOf(field)?.value ?? '', password: field.value }
  }

  function reportSubmit (passwords: HTMLInputElement[]): void {
    if (!config.enabled || !config.save) return
    const credential = credentialIn(passwords)
    if (credential === null) return
    const key = `${credential.username}\u0000${credential.password}`
    const now = Date.now()
    if (lastSent !== undefined && lastSent.key === key && now - lastSent.at < DUPLICATE_MS) return
    lastSent = { key, at: now }
    send({ type: 'submit', ...credential })
  }

  /** The password fields a gesture on `target` submits: those whose form holds it. */
  const submittedBy = (target: Element): HTMLInputElement[] =>
    passwordInputs().filter((password) => password.value !== '' && scopeOf(password).contains(target))

  document.addEventListener('focusin', (event) => {
    if (!config.enabled || !(event.target instanceof HTMLInputElement)) return
    const target = event.target
    const password = target.type === 'password' ? target : passwordInputs().find((candidate) => usernameOf(candidate) === target)
    if (password === undefined || !usable(password)) return
    lastPassword = password
    reportFields()
    // An event a script dispatched is not the person's, and neither is an autofocus on load: the chooser waits for a
    // touch of the page that is still recent. Chromium reports a focus() a script makes as trusted, so the recent
    // touch is what tells the person's focus from the page's.
    if (!event.isTrusted || !config.autofill || !navigator.userActivation.isActive) return
    focusReported = true
    send({ type: 'focus', rect: rectOf(target), viewWidth: window.innerWidth, signUp: isSignUp(passwordsOf(scopeOf(password)).map(infoOf)) })
  }, true)

  document.addEventListener('focusout', () => {
    if (!focusReported) return
    focusReported = false
    send({ type: 'blur' })
  }, true)

  document.addEventListener('submit', (event) => {
    // A page can dispatch a submit event of its own; only the browser's counts as a sign-in.
    if (!event.isTrusted || !(event.target instanceof Element)) return
    reportSubmit(passwordsOf(event.target))
  }, true)

  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.key !== 'Enter' || !(event.target instanceof Element)) return
    reportSubmit(submittedBy(event.target))
  }, true)

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const button = event.target.closest(SUBMIT_LIKE)
    if (button === null) return
    if (isRevealControl(`${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`)) return
    reportSubmit(submittedBy(button))
  }, true)

  document.addEventListener('DOMContentLoaded', () => { reportFields() })
  window.addEventListener('load', () => { reportFields() })

  function fill (command: FillCommand): void {
    const inputs = passwordInputs()
    const target = lastPassword !== null && lastPassword.isConnected && usable(lastPassword) ? lastPassword : inputs[0]
    if (target === undefined) return
    if (command.username !== null) {
      const username = usernameOf(target)
      if (username !== null) setValue(username, command.username)
    }
    const fields = command.both ? passwordsOf(scopeOf(target)) : [target]
    for (const field of fields) setValue(field, command.password)
  }

  ipcRenderer.on(FORM_FILL_CHANNEL, (_event, message: unknown) => {
    if (!isRecord(message)) return
    if (message['type'] === 'config') {
      config = { enabled: message['enabled'] === true, save: message['save'] === true, autofill: message['autofill'] === true }
      if (config.enabled) activate()
      else deactivate()
      return
    }
    if (message['type'] === 'fill' && config.enabled && typeof message['password'] === 'string' &&
      (message['username'] === null || typeof message['username'] === 'string')) {
      fill({ type: 'fill', username: message['username'], password: message['password'], both: message['both'] === true })
    }
  })

  send({ type: 'hello' })
}
