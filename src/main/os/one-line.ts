// A page's words, made safe to place on one line of a file or a mail header.

/** C0 and C1 controls, line and paragraph separators, and the marks that reorder text. */
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g

/** `text` with each run of unsafe characters and of whitespace as one space, trimmed. */
export function oneLine (text: string): string {
  return text.replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
}
