// `exec`'s command string, split into a program and its arguments the way a
// POSIX shell splits a simple command. There is no shell to run anything
// else, so a command using one (a pipe, a redirect, a variable, a glob)
// refuses by name instead of running with the wrong meaning.

import { refuseShim } from '../errors.js'

/** Characters with a meaning to the shell outside quotes; `#` also starts a comment at a word's start. */
const SHELL_SYNTAX = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '~', '\n'])

export function splitCommand (command: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1] as string)) word += command[++i]
      else if (char === '$' || char === '`') throw shellRequired(command)
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      inWord = true
    } else if (char === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (char === ' ' || char === '\t') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else if (SHELL_SYNTAX.has(char) || (char === '#' && !inWord)) {
      throw shellRequired(command)
    } else {
      word += char
      inWord = true
    }
  }
  if (quote !== undefined) throw shellRequired(command)
  if (inWord) words.push(word)
  return words
}

function shellRequired (command: string): Error {
  return refuseShim('child_process.exec', 'not-applicable',
    `"${command}" needs a shell, and an app has none: run the program with execFile and its arguments instead`)
}
