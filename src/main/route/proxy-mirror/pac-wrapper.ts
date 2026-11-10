// The system's proxy script made safe to hand to Chromium: a script of our own that answers `DIRECT` for every name the verifier
// serves before the system's text runs, and runs that text where it cannot reach what decides it. Pure: it only builds text, which
// Chromium's PAC context runs. README.md's Design notes say why each piece of it is as it is.

/** A host suffix as the routed list spells one: lower-case labels, no dot at either end. */
const SUFFIX = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/

/** `text` as a string literal of plain ASCII, one escape per UTF-16 unit outside the printable range, so no charset or line terminator changes what it says. */
function literal (text: string): string {
  let out = '"'
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at)
    if (unit === 0x22) out += '\\"'
    else if (unit === 0x5c) out += '\\\\'
    else if (unit >= 0x20 && unit <= 0x7e) out += text[at]
    else out += `\\u${unit.toString(16).padStart(4, '0')}`
  }
  return `${out}"`
}

/** Each character of `.suffix` as its two spellings, so the check compares characters by index and calls nothing a script could have replaced. */
function spellings (suffixes: readonly string[]): string {
  for (const suffix of suffixes) if (!SUFFIX.test(suffix)) throw new Error('a routed suffix must be lower-case labels')
  return JSON.stringify(suffixes.map((suffix) => [...`.${suffix}`].map((character) => [character, character.toUpperCase()])))
}

/**
 * The text of a proxy script that gives `DIRECT` for a host under any of `suffixes` (with any number of root dots, in any case) and
 * the answer of `script` for every other. `script` runs once, as the body of a function made inside the closure, so it cannot reach
 * the closure's names; the global `FindProxyForURL` Chromium reads is an accessor that cannot be redefined or deleted, and a script
 * that assigns the name has what it assigned taken as its own function. A script that throws, does not compile or defines no
 * function answers `DIRECT` for every name, as Chromium does for a script that fails, and an assignment made after it failed is
 * ignored; an answer that is not a string of ASCII is a failure of the call and so is `DIRECT` too.
 */
export function wrapPacScript (script: string, suffixes: readonly string[]): string {
  return `(function (g) {
'use strict';
var TEXT = ${literal(script)};
var SUFFIXES = ${spellings(suffixes)};
var system;
var assigned = false;
var loading = true;
var failed = false;
function routed (host) {
  if (typeof host !== 'string') return true;
  var end = host.length;
  while (end > 0 && host[end - 1] === '.') end -= 1;
  for (var s = 0; s < SUFFIXES.length; s += 1) {
    var suffix = SUFFIXES[s];
    var length = suffix.length;
    if (end < length) continue;
    var matches = true;
    for (var i = 0; i < length; i += 1) {
      var character = host[end - length + i];
      if (character !== suffix[i][0] && character !== suffix[i][1]) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}
function plain (answer) {
  if (typeof answer !== 'string') return 'DIRECT';
  for (var i = 0; i < answer.length; i += 1) if (answer[i] > '\\x7f') return 'DIRECT';
  return answer;
}
function wrapped (url, host) {
  if (routed(host)) return 'DIRECT';
  try { return plain(system(url, host)); } catch (error) { return 'DIRECT'; }
}
Object.defineProperty(g, 'FindProxyForURL', {
  configurable: false,
  enumerable: true,
  get: function () { return loading ? system : wrapped; },
  set: function (value) { if (failed) return; system = value; assigned = true; }
});
try {
  var found = Function(TEXT + '\\n;return FindProxyForURL').call(g);
  if (!assigned) system = found;
} catch (error) { system = undefined; failed = true; }
loading = false;
})(this);
`
}

/** `source` as the `data:` address `setProxy` takes for `pacScript`; the source is the ASCII `wrapPacScript` makes, and anything else is refused, because base64 of Latin-1 would change what a character says. */
export function pacDataUrl (source: string): string {
  if (!/^[\n\x20-\x7e]*$/.test(source)) throw new Error('a proxy script must be ASCII')
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(source, 'latin1').toString('base64')}`
}
