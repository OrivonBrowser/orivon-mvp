# `src/main/graphics/`: WebGPU on an X11 session

**What lives here.** The opt-in setting `graphics.webgpuOnX11` and what it does to this process.

| File | Job |
|---|---|
| `x11-vulkan.ts` | Pure: the rule for which display server Chromium runs on (`ozonePlatformOf`, `runsOnX11`, `offersX11Setting`), the switches (`applyX11Vulkan`), and the guard's decisions (`planStart`, `windowShown`, `turnedOn`, `revertAfterEnd`, `revertAfterStatus`) |
| `guard-file.ts` | The guard's record, `x11-vulkan.json` in the profile: read and written synchronously, never throwing |
| `x11-vulkan-runner.ts` | The Electron side: the switches before Chromium reads them, the start marker, the process events, the settings store |
| `graphics-domain.ts` | What the Settings page may ask: whether to offer the choice, and the last revert |

**What it depends on.** `electron` (the runner only); [`../settings/`](../settings/) (`readSettingBeforeReady`, `forceSettingsFile`, the store's `set` and `onChange`); [`../privacy/gpc-switch.ts`](../privacy/gpc-switch.ts) (the merge of one feature into `--enable-features`); [`../diagnostics/shell-console.ts`](../diagnostics/shell-console.ts) (`isOrdinaryEnd`, so the guard and the crash records agree on what a bad end is); [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts) (the shape of a domain).

**What it must never import.** [`../shell/`](../shell/) or the renderer: `index.ts` hands it the settings store and the publisher once they exist, and tells it when the first window was shown.

**Owner stream.** `shell`.

**Electron dependence.** Pure: `x11-vulkan.ts`, `guard-file.ts` (plain `fs`). Tied to Electron: `x11-vulkan-runner.ts`.

## Design notes

**The switches are `--use-angle=vulkan` and `Vulkan,VulkanFromANGLE`, because that is the smallest set that kept everything working.** Chromium 152 gives a page no WebGPU adapter on X11 for any graphics card (it sets the bridge from GL to Vulkan only under Ozone Wayland). With these switches the page gets an adapter and WebGL, painting and both VP9 and H.264 video still work, on a standalone Xwayland and under xvfb. Without `VulkanFromANGLE` WebGL is lost; without `Vulkan` there is no adapter. The set is added to `--enable-features` the way [`../privacy/gpc-switch.ts`](../privacy/gpc-switch.ts) adds its feature: Playwright's Electron launcher replaces a feature list given on the command line, so a test can reach the setting only through the profile's `settings.json`.

**It acts only where Orivon already runs on X11, and never forces it.** `ozonePlatformOf` mirrors Chromium 152's own rule (`SetOzonePlatformForLinuxIfNeeded`): an `--ozone-platform` switch that is set wins, else Wayland on a Wayland session, else X11. Forcing `ozone-platform: x11` on a Wayland session crashes the graphics process on some computers (`../README.md`), so this setting is never a way to get X11. Settings offers the choice on an X11 session only; Orivon running on X11 inside a Wayland session (XWayland) is told to run on Wayland instead, and the choice is not shown there.

**Which card Vulkan picks is not the setting's to say.** On a laptop with two graphics cards the Vulkan device is the NVIDIA one whatever render node Chromium was given; Intel is reached only by limiting Vulkan to its driver with `VK_ICD_FILENAMES`, which is no Chromium switch. The help text says what this costs.

**The guard exists because the reason Chromium turned this off is a blank video on some laptops, and a crash is the other way it can go wrong.** It reverts in three cases, and keeps why (`x11-vulkan.json`, shown in `orivon://gpu` and carried in a report):
- the graphics process ended badly in a run that set the switches (the same ends the crash records count, `isOrdinaryEnd`): the setting is turned off at once, and takes effect at the next start;
- ten seconds after the first window, Chromium still draws pages on the processor (`app.getGPUFeatureStatus().gpu_compositing` is not `enabled`): a Vulkan driver that cannot be loaded makes the graphics process exit during its start-up and start again until Chromium gives up, which no end of a process reports. The setting then gave nothing and cost every page its graphics card, so it is turned off. On a computer that drew on the processor before the setting was on, the guard turns it off too, on purpose;
- a run that set the switches never showed its first window: the start marker is written before Chromium reads the switches and removed when the window is shown, so the next start finds it and reverts before applying anything.
Turning the setting on again forgets the record. A private session follows the copy of the settings it started from and keeps its own record, which goes with it.

**Not measured.** A real Xorg session, which is the case upstream's block was written for (video composited blank on an NVIDIA hybrid laptop). Until a computer like that has run this, whether the video decoder picks the integrated GPU there is *provisional*; a report from `orivon://report` on such a computer would settle it.
