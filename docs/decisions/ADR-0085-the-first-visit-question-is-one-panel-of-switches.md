# ADR-0085: The first-visit question is one panel of switches

- **Status:** accepted. Replaces the question shape of [`ADR-0074`](ADR-0074-a-published-app-is-asked-about-and-checked-before-its-page-is-entered.md) (a yes or no for the whole set, or a staged sequence for an app that asked one by one).
- **Date:** 2026-10-14
- **Type:** product / security
- **Decided by:** owner (one panel of switches with Grant all and Close; the key wears a dot while permissions are off; the key popup gives the question back)

## Decision

The question a first visit asks about an app is one panel, whatever the app's `consentGranularity`. It names the origin first, then what the app wants, then one row for each capability still being decided (neither held nor refused already): the icon and the words the key popup uses for that capability, a warning style for a warning row, and a switch, every switch off. Its two buttons are Close, drawn as plain text, and Grant all, the filled one.

- **Grant all** grants every row. **Close** grants exactly the rows switched on and records the rest as declined, one by one. **Close with every switch off is a no**: the site stays the plain website it already is and is not asked about again until Settings, Sites asks again.
- **Escape, a closed tab, a navigation and a withdrawn question are not an answer.** Nothing is recorded, and the app is not asked about again for the rest of the run (`later`).
- An app that asked for its capabilities together shows the key popup's own line, "This app asked for these together; turning one off may break it.", while any switch is off. An app that asked one by one shows none.
- Switching a row grants nothing; only a button does. Both buttons ignore a press for the guard's length after the panel is drawn, and focus starts on the panel.
- An app Orivon already holds, whose manifest later asks for more, is asked with the same panel about what is new only.

**The key says when permissions are off.** The address bar's key wears a small accent dot while an installed app has a declared capability switched off, and while an app was never let in (its question dismissed this run, or closed with nothing on). The key popup of an app never let in says so in one sentence and offers *Review permissions*: it forgets the dismissal and the refusal, lets go of the cache a dismissal kept staged, and reloads the tab, so the page's manifest hint runs the first visit again and the panel asks.

## Context

The text question could only say yes or no to a set, and an app that asked one by one was led through an overview and one screen per capability. Both are slower than a row of switches the person can read at once, the key popup already used switches for the same capabilities, and a person who dismissed the question or said no had no sign afterwards that the app was running without what it asked for, nor a way back short of Settings.

## Alternatives considered

- **Keep the two questions and add switches only to the per-capability one.** Rejected: an app's `consentGranularity` is the app's own choice, and the person's choice to hold a part of what it asks is theirs either way. One panel is one thing to learn, and the together line carries what the app said.
- **Switches start on, and a person turns off what they refuse.** Rejected: a grant must be something the person did. A person who presses Close without reading would grant everything.
- **Close with some switches on, then ask again about the rest at the next visit.** Rejected: that is a question the person already answered by leaving a switch off, and the refused capabilities are recorded as declined so they are never asked again.
- **A dot on the key only for an installed app.** Rejected: an app never let in is the case where the person most needs to see that the page is running without what it asked for.
- **Review permissions opens the panel from the popup without a reload.** Not done: the first visit begins when the page's own manifest hint arrives, and reloading is how it arrives; a second way to start a visit could ask the same person twice.

## Reasoning

A row of switches puts the whole request on one screen, in the words the person will see again in the key popup, and lets them keep the part they want. Treating Close with nothing on as a no keeps the one rule the earlier questions had (only a pressed refusal is recorded) and gives Escape its meaning of "not now". The dot and Review permissions make the state the panel leaves behind visible and reversible from where the person already looks.

## Consequences

- An app must work with a subset of what it declares; one that asked for its capabilities together is told so in the panel and in the key popup, nothing more.
- A widened manifest of an app Orivon already holds asks only about what is new: a capability the person refused before is not asked again.
- `consentGranularity` changes the one line of the panel and nothing else; the staged sequence and its screens are gone.
- The question for a file on this computer, the runtime `app.requestGrant` question and the update question keep their own looks.

## Reversibility

- **Cost to reverse:** cheap. The panel is a question spec with rows; the old shapes are the same spec with two buttons.
- **What would make us revisit:** a measured rise in apps that fail after a Close with some switches off, which would argue for asking again about the rows left off.
