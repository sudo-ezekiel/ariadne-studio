---
title: "Running FAQ: Maestro runs, flaky cases and reports"
description: Frequently asked questions about Run, Run all, flaky cases, the looks different flag, reports and run video in Ariadne.
---

# Running

Frequently asked questions about running cases.

## What does "looks different" mean?

The replayed screen is under 85% alike the recorded one. It never fails a run. It points at a screen worth a look, such as a dialog that appeared. See [Looks different](/guides/run#looks-different).

## What does `flaky` mean?

A case is `flaky` when its last ten runs since its last edit both passed and failed. In Run all, a case that failed and then passed on the retry is reported as `flaky`.

## Why are my old runs marked stale?

The case's steps changed after those runs, so their rows may not line up with the steps. They stay in the history list and do not count for the case's status.

## How long can a run last?

5 minutes, then Maestro is stopped and the run fails with "Maestro did not finish in time and was stopped."

## Can I keep using the studio during Run all?

You can read results, and anything that would use the device waits or is refused until Run all ends. **Stop after this case** ends it early.

## Why does Run need the device to itself?

Maestro brings its own UiAutomator driver and only one can own the device. The studio closes its session for the run and reopens it afterwards without restarting the app.

## Can I run a case without Ariadne?

Yes. `maestro test flows/<caseId>.yaml` from the project folder, with `-e KEY=VALUE` for any values it uses. See [CI](/guides/ci).

## How do I send a result to someone?

**Shareable report** on a run writes one HTML file with everything inlined. See [Reports](/guides/run#reports).

## Is the run video uploaded anywhere?

No. It is made on your machine and stays in `runs/<runId>/`. See [Run video](/guides/run-video).

## Why does my run video show only the phone?

The steps are added by `ffmpeg`, and the studio could not find it or could not finish. Install [ffmpeg](https://ffmpeg.org/download.html), or set `ARIADNE_FFMPEG` to its path. The studio's log says why when it was found and failed.

## Why did my run video stop early?

Android's screen recorder may stop at 3 minutes on a long run.

## Does Run all cover muted cases?

No. Run all skips them. `maestro test` on the flows folder does not know about muting and runs them.
