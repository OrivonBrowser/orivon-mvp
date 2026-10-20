# ADR-0094: An `orivon:` link from another program opens a `.eth` name or an IPFS address, and nothing else

- **Status:** accepted, provisional until a built package has been seen taking the link on Windows and macOS
- **Date:** 2026-10-20
- **Type:** security
- **Decided by:** owner

## Decision

Orivon registers the link scheme `orivon` with the system: `electron-builder.yml` `protocols` (the macOS
`CFBundleURLTypes`, the Linux desktop entry's `x-scheme-handler/orivon`, and the Microsoft Store manifest's protocol
extension), and `build/installer.nsh` for the Windows installer (`Software\Classes\orivon`, whose command is
`"<install>\Orivon.exe" -- "%1"`, removed on uninstall). The only form it reads is
`orivon:open?u=<target>[&flavour=<id>]`, also written `orivon://open?u=...` because some programs rewrite it.

`<target>` is a `.eth` name with an optional path, or an `ipfs://` or `ipns://` address, percent-encoded or not. The
link opens as the address bar would open the same text, in a new tab of the open window, or in the first window of a
cold start. Anything else is refused and opens nothing: Orivon starts or comes to the front and shows what it
would have shown. A refusal says nothing.

The parser is one pure function (`src/main/launch/orivon-link.ts`), and the three ways in share it with the
http(s) links they already take: a command line (a second launch on Linux and Windows, a cold start), the macOS
`open-url` event, and the request the second launch sends the first. The link becomes a web address before it is
queued, so the check made on a request from another process is unchanged.

`flavour=<id>` is read and its shape checked (`^[a-z0-9]{2,24}$`); a missing, malformed or repeated one is dropped and
the target still opens. A valid id is handed to a single function, `firstRunFlavourHint`, only on the start of a
browser that a link started. The function does nothing yet: it is where a later change that opens a chosen app on a
first run will hook in.

## Context

A link on a web page or in a message can only open Orivon if the system knows a scheme for it. `https://name.eth` and
`ipfs://...` addresses do not open in Orivon from another program: the first goes to whatever browser is the default and
the second to nothing. A scheme of Orivon's own is a link that works for the people who have it installed and degrades
to nothing (not to a wrong site) for those who have not.

An OS entry point is a trust boundary. The text arrives from any program, a web page's `<a href>` after the browser's
own external-protocol question, a document, or a chat message, and on Windows it arrives through a command line
that a quote can break out of.

## Alternatives considered

**Register nothing; use `https://orivon.<domain>/open?...` links.** Needs a server to host the redirect, and a
`universal link` handshake on macOS that the app has to be signed to receive. It also sends the target to that
host. Rejected: the point is a link that works without a request to anyone.

**Accept any http(s), `ipfs://` or `ipns://` address after `u=`.** Rejected: a link is an address typed by someone
else, and Orivon already opens every http(s) address another program hands it. A second route for the same thing
adds nothing, and widens what an `orivon:` link can be made to do the day the scheme gains a new action. The
two kinds it takes are the two kinds Orivon verifies.

**Refuse a whole link whose `flavour=` is malformed.** Rejected: the id is a hint for later presets and the target
is what was asked for. A hint with a wrong shape is dropped, the target opens.

**Let the link carry `settings`, `import` or an app install as other actions.** Rejected: each is a command from outside
the process, and none is needed for the first use of the scheme. A new action is a new decision.

## Reasoning

The scheme is short and the accepted set is closed. Every refusal is by allow-list, not by a list of bad schemes:

- The raw text is limited to the characters of RFC 3986 minus `"`, `<`, `>`, `\`, `^`, `` ` ``, `{`, `}` and `|`, to 2048
  characters, and to no `#`. A quote cannot end the quoted argument of the Windows command, and a space, a control
  character or a non-ASCII character in the raw text means a program built the link carelessly or hostilely.
- `u=` must appear once. It is decoded once. The decoded target may not hold a control, a space, a bidirectional or
  other invisible formatting character, or a backslash, so a name cannot be made to read as another.
- The scheme of the target is `ipfs` or `ipns` (case-insensitive), or none; a name without a scheme must end in `.eth`
  and be ASCII labels of letters, digits and hyphens. There is no port, userinfo or second `orivon:` link.
- A path segment of `.` or `..`, written plainly or with `%2e`, and any escaped `/` or `\`, are refused. The URL
  parser would otherwise collapse the segment, and the target could leave the name the link shows.
- The Windows command ends the switches with `--`, as the browser registration's does, so a link is never read as a
  switch; the browser's own launch code stops at the first `--` too.

The target opens through the same tab path as a typed address, so the consent question an app asks on first visit,
the verification of `.eth` and IPFS content, and the loading screen are all the ordinary ones. A link grants nothing.

## Consequences

- **A new place text enters from outside the process**, owned by `src/main/launch/`. It is covered by unit tests of
  every accepted and refused form, and a change to the accepted set is a change to this decision.
- **No request is added.** Parsing a link makes none; opening the target is the navigation a person would have made.
- **A run from source registers nothing** on Windows or macOS, and the Linux "Orivon (source)" entry does not claim
  `x-scheme-handler/orivon`: a checkout must not take the links from an installed Orivon. A link works there only when
  it is given on the command line.
- **The AppImage does not integrate** with the desktop, so it does not take the scheme either; a .deb install does.
- **The scheme is Orivon's from the install on Windows**, not a choice under "Default apps": no other program
  claims it, so there is nothing to choose between.
- **A different program registered for `orivon` by a later install wins on Linux and macOS**, as for any scheme.

## Reversibility

- **Cost to reverse:** cheap while no link has been published. Once links in the world use the scheme, removing it
  breaks them, and the accepted form is then a contract.
- **What would make us revisit:** a second action wanted from outside the process; a built package that does not take
  the link on Windows or macOS; a link form some program rewrites that this one refuses.
