# `test/apps/`: the apps the test suite serves

**What lives here.** The applications this repository's own end-to-end suites load from a URL:
[`fixture/`](fixture/), the minimal app the broker and loader tests drive, and
[`freetube/`](freetube/), a YouTube frontend written as an ordinary Orivon app. Each carries its
own `README.md`.

**What it depends on.** `orivon.*` at runtime, and nothing else.

**What it must never import.** Anything under `src/`. These are ordinary URL-delivered apps and
hold zero silent privileges -- if one needs a path a third-party app could not take, the thesis
is untested.

Ported third-party applications are not here; they are built in `orivon-ports` (`ADR-0020`).
