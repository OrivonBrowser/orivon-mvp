# ADR-0106: A website asks before it gets WebGPU, and on X11 granting it turns the graphics mode on

- **Status:** accepted. Carries out `d-0761` and `d-0762`. Amends [`ADR-0105`](ADR-0105-webgpu-on-an-x11-session-is-an-opt-in-setting-that-composites-through-vulkan-and-turns-itself-off-after-a-bad-run.md): its setting gains a second way to be turned on.
- **Date:** 2026-11-05
- **Type:** product / security
- **Decided by:** owner (a question on every computer, its wording "Grant WebGPU", grant then restart on X11, the Settings switch kept as the way to turn the mode off); AI recommendation accepted by default for where the question is asked and what enforces it, marked *provisional* below where it is not settled

## Decision

**WebGPU is one more kind of thing a site is asked about, `webgpu`, labelled "WebGPU".** It sits in the per-site table beside the camera and the location (`src/main/site-settings/kinds.ts`): its default is Ask and may be set to Block in Settings, Sites; a site's Allow and Block are both kept; closing the question decides nothing for that page load. The address bar's chip, the site-info popup and the Settings list show it as they show the other kinds.

**The question appears when a website's page asks for an adapter.** A call to `navigator.gpu.requestAdapter()` from the page waits while Orivon asks under the address bar: the site, "wants to use your graphics card for WebGPU", and the buttons Block and **Grant WebGPU**. Granted, the page gets the adapter; blocked or closed, it gets `null`, which is what a page gets on a computer without WebGPU, so a site's own fallback runs. The rules of the other kinds hold: only the tab in front is asked, a frame never asks, a page that moves on while the question is open gets `null` and nothing is kept.

**It is asked only where the answer can change what the page gets.** Orivon makes the page's call first. When Chromium gives an adapter, the question decides whether the page has it. When Chromium gives none, the page gets `null` and nobody is asked, with one exception: on an X11 session, in a run that did not start in the graphics mode of `ADR-0105`, which the guard has not turned off, in a window that is not private. There the question also says that Orivon must start again to turn WebGPU on, and what the mode may cost (battery, blank video on some laptops). **Grant WebGPU** then keeps the site's allow, turns `graphics.webgpuOnX11` on, and offers **Restart Orivon** beside **Later**; restarting opens the page that asked again. A site that already has an answer is never asked again, so a person who turned the mode off in Settings is not asked by the sites they granted.

**The Settings switch stays.** "Use the graphics card for WebGPU on X11" is still where the mode is turned off, and still turns it on by hand; granting a site turns it on as well.

**An origin that holds grants is not asked.** An installed app with grants has the permissions of its manifest and no question asks for more (`test/app-behaviours/catalogue.md`, `installed-app-without-grants-is-asked-as-a-website`). It gets the WebGPU Chromium gives, unasked; an installed app that holds no grant is asked as a website is.

**The question is asked from the page's top frame.** The tab preload wraps `GPU.prototype.requestAdapter` in the main world of a website tab's top frame, and main decides from the frame it hears from (its committed origin, never a value the page sends). Electron 44 reports no WebGPU request to the browser process, so this is the one place a request can be seen. A failure to ask gives the page `null`, never an adapter.

## Context

The owner asked that each website that asks for WebGPU gets a question saying "Grant WebGPU", in place of reaching it only through a switch in Settings (`d-0761`). On Windows and macOS Chromium 152 gives every page WebGPU unasked; on an X11 session it gives none until the mode of `ADR-0105` is on, which is read when Orivon starts ([`webgpu-plan.md`](../planning/webgpu-plan.md)).

## Alternatives considered

- **Ask before the page's call reaches Chromium, on every computer.** Rejected: on a computer that has no WebGPU (a Wayland GPU off Chromium's list, a Windows computer with no GPU) the person would grant and get nothing.
- **A permission in the browser process.** None exists: `setPermissionRequestHandler` is never called for WebGPU in Electron 44, and no permission name or Permissions Policy feature covers it.
- **Turn WebGPU off per tab (`disableBlinkFeatures: 'WebGPU'`) unless the site is granted.** Rejected: the setting is fixed when a tab's view is made, so a tab moving between a granted and an ungranted site would need a new view, and would lose its history with it.
- **Wrap the page's workers and frames as well.** Rejected: no preload reaches a worker, or a frame of a tab (`nodeIntegrationInSubFrames` is off), and rewriting a page's `Worker` constructor breaks module workers and the page's own Content Security Policy.
- **The graphics mode always on X11, so Grant WebGPU works at once.** Rejected by the owner: every X11 user would pay its battery and video cost.
- **Remove the Settings switch.** Rejected by the owner: the mode needs a way off that does not take WebGPU from every site.

## Reasoning

The question belongs with the per-site kinds because a person already knows that shape: one question per site, the answer kept, changed from the chip or Settings. Asking only where an adapter exists, or where a restart gives one, keeps the question honest: a Grant WebGPU never leads to nothing. On X11 the mode costs every page of the browser, so it is turned on only by a person who granted a site, which is what `d-0758` asked of the switch.

## Consequences

- On Windows and macOS a site that used WebGPU unasked now asks once. Its call waits for the answer, so a page that gives up after a timeout of its own sees no adapter.
- A page in a tab out of sight gets `null` without a question (the rule every kind follows), and is asked on its next load in front.
- **Provisional: the question binds a site's page, not its frames or workers.** A frame, and a worker the page starts, get the WebGPU Chromium gives unasked, so on Windows and macOS a site that asks from a worker or a frame is not asked, and on X11 without the mode it gets nothing and no question. The question is consent for a site that asks the usual way, not a boundary a site cannot go around. What would settle it: a WebGPU permission or request hook in Electron, or the measured share of WebGPU sites that ask from a worker first.
- The adapter is made before the person answers, and the page holds it only once granted.
- A restart from the question does not bring back the other tabs and windows, as with the Settings switch.
- A bug report carries the WebGPU default and how many sites are allowed and blocked, never which.

## Reversibility

- **Cost to reverse:** cheap. One kind, one page-side wrapper, one main-side handler and one more state of the prompt.
- **What would make us revisit:** Electron exposing a WebGPU permission (the gate moves to the browser process and covers frames and workers), or reports of WebGPU sites that never ask because they start in a worker.
