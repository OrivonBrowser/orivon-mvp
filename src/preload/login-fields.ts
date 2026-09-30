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
