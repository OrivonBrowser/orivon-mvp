// `constants` module target (module-map.ts): Node's deprecated flat merge of
// os.constants (errno, signals, priority, dlopen), fs.constants and
// crypto.constants, as plain numbers that graceful-fs and random-access-file
// read their open flags from as they evaluate. Linux's values, from a snapshot
// of real Node (constants.generated.json), the numbering node-errors.ts uses.

import table from './constants.generated.json'

export const constants: Readonly<Record<string, string | number>> = Object.freeze({ ...table.constants })

export default constants
