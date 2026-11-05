// The decisions the form watcher makes about a page's inputs, over plain objects so a unit test needs no DOM:
// which field is the username of a password field, which password a submission carries, whether a form is
// a sign-up. `form-watch.ts` reads the DOM into these shapes; nothing here touches one.

/** What the decisions need to know of one `<input>`. */
export interface FieldInfo {
  readonly type: string
  readonly autocomplete: string
  readonly value: string
  readonly disabled: boolean
  readonly readOnly: boolean
  /** Laid out with a size and not hidden or transparent-by-style: what a person could type into. */
  readonly visible: boolean
}

/** The `autocomplete` tokens, lower-cased: `"section-a new-password"` is two. */
export function autocompleteTokens (value: string): string[] {
  return value.toLowerCase().split(/\s+/).filter((token) => token !== '')
}

/** A box with a size, not hidden by `display` or `visibility`. */
export function isVisibleBox (box: { width: number, height: number }, style: { display: string, visibility: string }): boolean {
  return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
}

const USERNAME_TYPES = new Set(['', 'text', 'email', 'tel'])

/** An input that could hold a username: a text-like type, or one the page itself labels as an account name. */
export function canBeUsername (field: FieldInfo): boolean {
  if (!field.visible || field.disabled || field.readOnly) return false
  const tokens = autocompleteTokens(field.autocomplete)
  if (tokens.includes('username') || tokens.includes('email')) return true
  return USERNAME_TYPES.has(field.type.toLowerCase())
}

/**
 * The index of the username among the inputs that come before a password field in document order: the
 * nearest one the page labels `username`, else the nearest text-like one. -1 when there is none.
 */
export function chooseUsername (before: readonly FieldInfo[]): number {
  let labelled = -1
  let nearest = -1
  before.forEach((field, index) => {
    if (!canBeUsername(field)) return
    nearest = index
    if (autocompleteTokens(field.autocomplete).includes('username')) labelled = index
  })
  return labelled !== -1 ? labelled : nearest
}

/** A form that makes an account: a field the page says is new, or a password asked for twice or more. */
export function isSignUp (passwords: readonly FieldInfo[]): boolean {
  return passwords.some((field) => autocompleteTokens(field.autocomplete).includes('new-password')) || passwords.length >= 2
}

/**
 * Which of a form's password fields holds the password to keep: the one the page says is new, else, in a
 * form of three (current, new, repeat), the middle one, else the first that has a value. -1 when none has.
 */
export function choosePassword (passwords: readonly FieldInfo[]): number {
  const fresh = passwords.findIndex((field) => field.value !== '' && autocompleteTokens(field.autocomplete).includes('new-password'))
  if (fresh !== -1) return fresh
  if (passwords.length === 3 && passwords[1]?.value !== '') return 1
  return passwords.findIndex((field) => field.value !== '')
}

/** Words on a button that show or hide what was typed: pressing one is not a submission. */
export function isRevealControl (label: string): boolean {
  return /\b(show|hide|reveal|unmask|visib\w*|eye)\b/i.test(label)
}

/**
 * Whether the chooser should lead with a strong password, for a page whose password fields are grouped by form.
 * A page with a sign-in form and a sign-up form is neither: only the form the person touched answers, and with no
 * touch only a page whose every form is a sign-up does.
 */
export function pageIsSignUp (signUps: readonly boolean[], focused: number): boolean {
  const own = signUps[focused]
  if (own !== undefined) return own
  return signUps.length > 0 && signUps.every(Boolean)
}

/**
 * The form a fill goes to when no box was touched: the first sign-up form for a fill of the new password, the first
 * other form for a saved account. Falls back to the first form; -1 when there is none.
 */
export function fillScope (signUps: readonly boolean[], both: boolean): number {
  if (signUps.length === 0) return -1
  const wanted = signUps.indexOf(both)
  return wanted === -1 ? 0 : wanted
}

/** How many ancestors above a box that has no form are searched for the one that scopes it. */
export const SCOPE_LEVELS = 6

/**
 * Which ancestor scopes a box that has no form, given for each ancestor, nearest first, whether it holds another box of
 * the sign-in kind: the nearest that does within `SCOPE_LEVELS`, else the parent (0).
 */
export function scopeLevel (holdsOther: readonly boolean[]): number {
  const at = holdsOther.slice(0, SCOPE_LEVELS).indexOf(true)
  return at === -1 ? 0 : at
}

/** Password boxes that belong together, and the scope that holds them all. */
export interface ScopeGroup<T> { readonly scope: T, readonly members: readonly number[] }

/**
 * Groups boxes by the scope each was given: two share a group when their scopes are one element or one holds the other,
 * as a page that wraps each box in its own layers puts a box and its confirmation at different depths. A group's scope is
 * the one that holds the rest. Groups come in the order of their first box.
 */
export function groupByScope<T> (scopes: readonly T[], holds: (outer: T, inner: T) => boolean): Array<ScopeGroup<T>> {
  const root = scopes.map((_, index) => index)
  const find = (index: number): number => {
    let at = index
    while (root[at] !== at) at = root[at] as number
    return at
  }
  scopes.forEach((outer, i) => {
    scopes.forEach((inner, j) => {
      if (i < j && (outer === inner || holds(outer, inner) || holds(inner, outer))) root[find(j)] = find(i)
    })
  })
  const groups = new Map<number, number[]>()
  scopes.forEach((_, index) => { groups.set(find(index), [...groups.get(find(index)) ?? [], index]) })
  return [...groups.values()].map((members) => {
    const scope = members.map((at) => scopes[at] as T).find((candidate) => members.every((at) => scopes[at] === candidate || holds(candidate, scopes[at] as T)))
    return { scope: scope ?? scopes[members[0] as number] as T, members }
  })
}

/**
 * Which of a sign-up form's password boxes get a strong password: all but a box the page says is the current one and, in
 * a form of three (current, new, repeat), the first unless the page calls it new. The box the person is in always does.
 */
export function newPasswordBoxes (passwords: readonly FieldInfo[], touched: number): number[] {
  const says = (index: number, token: string): boolean => autocompleteTokens(passwords[index]?.autocomplete ?? '').includes(token)
  const kept = (index: number): boolean => !says(index, 'current-password') && !(passwords.length === 3 && index === 0 && !says(0, 'new-password'))
  return passwords.map((_, index) => index).filter((index) => index === touched || kept(index))
}
