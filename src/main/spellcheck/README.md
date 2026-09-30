# `src/main/spellcheck/`: spell checking in tabs, on or off

**What lives here.** `spellcheck.ts` keeps the set of sessions a tab has used and puts each in line
with the `spellcheck.enabled` setting; `install-spellcheck.ts` finds those sessions as tabs load and
re-applies the setting when it changes. The suggestions and "Add to Dictionary" in a right-click menu
are built in [`../shell/context-menu-groups.ts`](../shell/context-menu-groups.ts), not here.

**Tied to Electron, in part.** `spellcheck.ts` imports nothing and runs under plain Node;
`install-spellcheck.ts` uses the `web-contents-created` event and `Session.setSpellCheckerEnabled`.

**What it depends on.** [`../settings/`](../settings/) (the setting) and
[`../shell/window-registry.ts`](../shell/window-registry.ts) (type only, to tell a tab from the chrome).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or
[`../shell/tab-view.ts`](../shell/tab-view.ts): the shell does not know spell checking exists.

**Owner stream.** `shell`.

## Design notes

**A session is switched once a tab has used it, not when it is created.** A `Session` does not report
its partition, so "a session that belongs to an app" cannot be read from the session itself. Switching
only the sessions tabs load in leaves the shell's own session (the address bar) and the sessions of
embedded and child pages as they are.

**The custom dictionary is Chromium's own.** Words added through the menu live in the session's
dictionary: per session, and gone with a private session. No file of Orivon's holds them.

**The dictionaries are downloaded by Chromium**, once per language, on first use. The setting's help
text says so, because that is the one request a person might not expect from a spell checker.
