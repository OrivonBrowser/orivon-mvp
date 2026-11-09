# A game window with the graphics card's real limits: plan

**Need.** The owner asked for more GPU power for games built for the web, granted per site behind strong warnings. A
game studio's WebGPU web build is the live need, and a large engine's public WebGPU demo, measured on 2026-11-04,
refused this machine's Intel GPU over `maxStorageTexturesPerShaderStage` although the GPU could serve more.

**Decisions.** `d-0773` (games stay web builds), `d-0774` (real hardware limits only), `d-0775` (a game window of its
own), `d-0776` (the site asks, Orivon warns twice), `d-0777` (Wayland: the game window ignores entry 186). Builds on
[`webgpu-plan.md`](webgpu-plan.md), whose question (`ADR-0106`) still decides whether a site gets WebGPU at all.

## What no grant can give in this build

Electron 44.7.0 runs Chromium 152, and Orivon cannot add to Chromium's WebGPU. Measured or read on 2026-11-09:

- **Not in Chromium's WebGPU at all:** 64-bit texture atomics (gpuweb issue 4329, unscheduled), ray tracing (issues
  filed in October 2026, no proposal), mesh shaders (issue 3015). An engine's virtualised geometry, virtual shadow maps
  and hardware ray-traced lighting need them, so a web build ships without them whatever Orivon grants.
- **Memory:** a 32-bit WebAssembly heap stops at 4 GiB. Memory64 is on (measured: a page creates an `i64` memory),
  and V8 caps it at 16 GiB. No switch is needed.

## What each switch gives, measured

A plain Electron 44.7.0 app with a scratch profile, on a virtual X display, with the X11 graphics mode's switches
(`--use-angle=vulkan`, features `Vulkan` and `VulkanFromANGLE`, `ADR-0105`) as the baseline. The page asks for an
adapter with each power preference, reads its features and limits, asks for a device with every one of them, and
creates a buffer with an invalid usage inside a validation error scope. GPUs: an NVIDIA RTX 3050 (Ampere) and an
Intel Tiger Lake GPU (Gen12), a hybrid laptop.

| Added to the baseline | NVIDIA | Intel |
|---|---|---|
| nothing | 19 features, limits rounded to Chromium's tiers | 23 features, limits rounded to Chromium's tiers |
| `--disable-dawn-features=tiered_adapter_limits` | 2D textures 16384 to 32768, 3D textures 2048 to 16384, `maxBufferSize` 4 GiB to 1 TiB, dynamic storage buffers 8 to 16, offset alignments 256 to 64 and 16 | storage textures per stage 4 to 8, sampled textures per stage 16 to 48, vertex attributes 16 to 29, uniform binding 64 KiB to 1 GiB, workgroup size Z 64 to 1024, offset alignments 256 to 64 and 4 |
| `--enable-unsafe-webgpu` | 5 more features: multi-draw-indirect, the sampling resource table (bindless textures), subgroup matrix, timestamps inside passes, unaligned texture compression | 4 more, the same without subgroup matrix |
| `--enable-dawn-features=skip_validation,disable_robustness` | the invalid buffer is created with no validation error | the same |
| `--enable-unsafe-webgpu` without the Vulkan switches | a SwiftShader adapter, `isFallbackAdapter: true` (a CPU adapter, refused by `d-0759`) | |
| `enableBlinkFeatures` or `disableBlinkFeatures: 'WebGPUExperimentalFeatures'` on one view | no change either way: the experimental features follow the switch alone | the same |

What follows from the table:

- **Every row is set for a whole browser process.** The Dawn toggles live in the GPU process, and the one per-view
  setting tried changes nothing. A tab cannot be given any of them alone.
- **Lifting the tiers is a privacy cost, not a memory-safety one.** Chromium rounds the limits so a site learns less
  about the GPU (Dawn commit `2e48f011`); the real limits tell it more precisely which GPU this is.
- **The Intel GPU's 4 storage textures per stage was a tier, not the hardware:** the GPU gives 8. Whether 8 is what
  the engine demo asked for is step 1.
- **Turning validation off is real.** A switch on the command line reaches Dawn, so with it a page's commands reach
  the driver unchecked.

## What is decided

- **Games stay web builds (`d-0773`).** Running a game's native build was weighed and not taken, so `ADR-0040`'s rule
  that Orivon runs no machine code for a site stands. The research behind the choice found no container that gives a
  game the GPU on all three systems: Ubuntu 24.04 restricts the user namespaces bubblewrap needs, Chromium does not
  run its own GPU process in a Windows AppContainer and nothing shows a game's GPU working in one, and Apple calls
  custom sandbox profiles unsupported.
- **A granted site gets the real hardware limits and nothing else (`d-0774`).** Chromium's experimental WebGPU
  features run code it has not finished reviewing, and Chrome warns that the switch lets a page read GPU data of other
  processes; validation off hands the driver whatever a page sends. Neither is offered.
- **A game window of its own (`d-0775`).** The site opens in a separate window run by its own Orivon process, the only
  process with the switch; everything else keeps Chromium's tiers.
- **The site asks, Orivon warns twice (`d-0776`).** A game calls one new `orivon.*` function; Orivon shows a strong
  warning and then a second confirmation, and only then opens the game window.
- **On Wayland the game window ignores blocklist entry 186 for every GPU maker (`d-0777`).** The rest of Orivon keeps
  `d-0757`'s list; a game window gets an adapter on a GPU nobody has tested, behind the warning and the crash guard.

## The shape, *provisional* until each step lands

**The game process** is a peer Orivon process, started as a private session is (`src/main/launch/peer-spawn.ts`):

- Its data directory is one per granted origin, kept under the profile, so a game's saves outlive the window and two
  games share neither storage nor a GPU process.
- **Switches, by platform:**
  - everywhere: `--disable-dawn-features=tiered_adapter_limits`;
  - Linux on X11: the X11 graphics mode's switches, whatever the main browser runs with, so a granted game needs no
    restart of Orivon;
  - Linux on Wayland: `--ignore-gpu-blocklist=186`, which alone gave an adapter on this machine
    ([`webgpu-plan.md`](webgpu-plan.md) section Where WebGPU stands in this build).
- **It shows one origin.** A top-level navigation to another origin opens in the main browser, handed over under T55's
  rules (an http(s) address, after the process's own switches); a same-site popup stays.
- **It starts with the site's tunnel** (`ADR-0089`) and the profile's settings, as a private session's seed does.
  The WebGPU grant's review found three things missed in its first draft: tab tunnels, `startup.mode` and AppImage
  relaunch. Each is checked here before the step is called done.
- **A crash guard per origin**, as `ADR-0105`'s: a GPU process that ends badly, or pages drawn on the processor, turns
  the switches off for that origin, with the time and the reason, and the question says so the next time.

**The question.** Asked only from a tab's top frame in front, never in a private window, and kept per site as the
camera's answer is. The first step names the site and the two costs in plain words:

- the site can tell exactly which graphics card the computer has;
- on Linux, a graphics card Orivon has not tested may show a blank or frozen game.

Its buttons are Block and Open game window. The second step repeats the site's name and asks again before the window
opens.

**What does not change.** The renderer sandbox, site isolation, the broker and every grant are as they are; the page
still reaches the GPU only through Chromium's validation. Two things widen: what a site can learn about the GPU, and,
on Wayland, which drivers a page reaches.

**Open, settled in step 3:** whether a game window asks for the site's `orivon.*` grants again in its own data, or
reads the main profile's ledger.

## Steps

1. **Measure before building.** Run the engine demo in the game process's configuration:
   - the Intel GPU alone, tiered against untiered (does it start where it refused?);
   - the NVIDIA GPU in the X11 mode;
   - Wayland on the hybrid laptop with entry 186 ignored, where the demo's canvas failed with the Vulkan feature alone.

   A *no* on the Intel run means the limits are not what holds that demo back, and the plan is weighed again.
2. **The contract, alone.** The `orivon.*` function, its ADR, a catalogue row and its spec in
   [`test/app-behaviours/`](../../test/app-behaviours/README.md), and the contracts surface snapshot.
3. **The game process.** The launch switch, the data directory per origin, the switches per platform, the navigation
   hand-off, the tunnel, the crash guard, and a threat row in `security-model.md`. The e2e covers what CI's virtual
   display can show: the process starts with the switches and holds the one origin; the adapter is checked on this
   machine, as `ADR-0106`'s is.
4. **The question.** The two steps, a site-settings kind with its Settings row, and what `orivon://report` carries:
   how many sites hold the grant and whether a game window ran, never which sites (Rule 24).
5. **Windows and macOS.** GitHub's macOS runner has a virtual Apple GPU that gives an adapter, so the untiered limits
   can be read there; its Windows runner has no GPU, so a Windows computer with a real GPU needs a tester.

## Not planned

- **Experimental WebGPU features and validation off** (`d-0774`).
- **A game's native build** (`d-0773`).
- **The game inside a tab.** Electron 44's experimental `sharedTexture` can bring another process's frames into a
  page as a `VideoFrame`, so a game window's picture could be shown in a tab later. It is not built until it is asked
  for.

## Privacy

The real limits identify the GPU, which is why only a granted site in a game window gets them. A bug report carries
the number of granted sites and whether a game window ran, never which sites.
