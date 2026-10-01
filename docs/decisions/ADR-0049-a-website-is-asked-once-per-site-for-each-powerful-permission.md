# ADR-0049: A website is asked once per site for each powerful permission, in a prompt Orivon draws

- **Status:** accepted
- **Date:** 2026-10-01
- **Type:** security
- **Decided by:** owner for the website door (ADR-0032); AI recommendation accepted by default for the kinds, the store, the prompt and the defaults below

## Decision

An ordinary website in a tab is asked, once per site, before it gets the camera, the microphone, its
location, the clipboard's contents, MIDI devices, idle detection, multi-screen window placement or
notifications. Allow and Block are both remembered; closing the question decides nothing. The
question is a card Orivon draws under the address bar (the `site-prompt` overlay, [ADR-0048](ADR-0048-orivon-s-own-overlays-share-one-host-and-one-preload-bridge.md)),
not a native message box, so one prompt can name two kinds at once and can say what Orivon cannot do.
The rules, which the permission gate's two handlers apply through one asker (`src/main/site-settings/`):

- **One store.** The answers live in `site-settings.json` in the profile: allow or block per origin and
  kind, at most 5,000 origins, every entry re-validated on read. A private runtime keeps the same store
  in memory. Notifications keep their own file, `notification-decisions.json`, and one controller reads
  and writes both, so site info and Settings list them side by side. The five content kinds (pop-ups,
  JavaScript, images, sound, automatic downloads) use the same store and the same surfaces, and are
  told apart only by being blocks the page never asks about, except automatic downloads, which ask.
- **The check handler never allows without a stored allow, and never asks.** It is synchronous. It
  answers `true` only for a stored allow of the page's own site, and it notes the allowance on the
  page's record so the address bar's chip can show it. A cross-origin frame (Electron reports an
  `embeddingOrigin`) never borrows its embedder's answer; a `media` check whose security origin is not
  the page's is refused; a frame never asks.
- **Registered app origins are excluded.** An origin the broker has registered, or one served from its
  pinned cache, gets its permissions from its manifest and grants, so the asker refuses it even when a
  stored allow exists, and the controller lists and writes no row for it.
- **Defaults.** A kind with no answer is asked (`ask`), or refused without asking when its setting
  (`sites.<kind>`) is `block`. There is no global allow for a permission: the choices for a default are
  Ask and Block. The content kinds start as the page expects (JavaScript, images and sound allowed,
  pop-ups blocked).
- **The prompt.** It takes focus, names the site as the broker's origin text does, has Block, Allow
  and Not now with no default button, and ignores a press in the first 500 ms. A navigation of the tab
  ends the question; a reload while it is open decides nothing for the new page. Camera and microphone
  are one question when a page asks for both, each answer stored. One surface is shown per tab at a
  time (a sheet before a prompt), the rest wait.
- **Location is asked and answered no.** Orivon has no location provider, so the answer is remembered
  and the page still gets `PERMISSION_DENIED`; the prompt says so before the person allows it.
- **Where an answer is changed.** The address bar's chip and its review bubble, the Permissions section
  of the site-info popover, Settings > Site settings, and Clear browsing data's "Site settings and
  permissions" box.

[ADR-0032](ADR-0032-camera-microphone-and-clipboard-read-join-the-grant-model.md)'s website door is
accepted as built here. Its app door (manifest kinds and install consent) stays `proposed` and unbuilt.

## Context

ADR-0032, decided by the owner, gave a website the traditional per-site prompt that ADR-0028 built for
notifications and left the build open. Until now the gate denied every page camera, microphone,
clipboard read, MIDI, idle detection and window management with no route to a yes. The notification
question was a native dialog attached to the window: it could not name two kinds, could not carry a
note, and could not be restyled with the rest of the shell.

## Alternatives considered

**Keep the native dialog.** One question per box, no note about location, no chip to review or change
a decision, and a look that differs on every platform. Rejected for those reasons.

**Allow by default and let the person block.** Rejected: camera, microphone, clipboard and location are
the permissions a hostile page wants most, and a stored default of allow would make the first visit the
decision.

**Ask every time, remember nothing.** Rejected: a video call would ask on every join.

**A global "allow" default for a kind.** Rejected: it recreates allow by default through a setting.

**Let a frame ask, or borrow its embedder's answer.** Rejected: the question would name the page's own
site while someone else's code is asking, which is the confusion a permission prompt must never have.

## Reasoning

A remembered, per-site, per-kind answer is what a person already expects, and it is the smallest rule
that lets AirGap Vault's paste and QR flows, calls and MIDI tools work on a website without a blanket
yes. Keeping the check handler a pure reader of the store is forced by Electron: the handler is
synchronous, so it cannot ask, and anything other than a stored allow must read as no. Drawing the
prompt ourselves costs one overlay and pays for the chip, the review bubble and one wording across
platforms. Excluding registered apps keeps the manifest the one place an app's authority is written
(ADR-0002).

## Consequences

- An undecided site reads `denied` from `Notification.permission` and from the Permissions API for
  every asked kind, not only notifications (`docs/open-questions.md` A243).
- There is no in-use indicator on the tab, and blocking a site does not stop a stream already running.
  This is ADR-0032's stated divergence, and it still stands.
- A page that never asks is never shown a question: Sensors, local fonts, the wake lock and persistent
  storage have no Electron permission name and are not covered.
- The prompt and the chip share one overlay definition, so pressing the chip while a question is open
  answers it "Not now".
- A kind stays out of every control until the feature that enforces it exists (`SITE_KINDS`), so the
  device and screen choosers have a declared kind that nothing lists yet.

## Reversibility

- **Cost to reverse:** moderate. The store's file format and the kind names are what a later version
  must keep reading.
- **What would make us revisit:** evidence of prompt fatigue in daily use, a need for a permission
  with no Electron name, or Electron gaining a permission surface of its own.
