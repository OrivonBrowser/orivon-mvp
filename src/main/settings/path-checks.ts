// The shape of a folder a setting may hold: decided here so a hand-edited settings file cannot make the
// downloads folder something other than a place on this computer.
import { isAbsolute } from 'node:path'

/** Empty (the operating system's own folder), or an absolute path with no control characters. */
export function isEmptyOrAbsolutePath (value: string): boolean {
  return value === '' || (isAbsolute(value) && !/[\u0000-\u001f]/u.test(value))
}
