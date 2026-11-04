---
title: Smoke tests
description: End-to-end proofs of recording, running and gestures on a real device, with no browser.
---

# Smoke tests

The unit tests use a fake device and a fake Maestro. The smoke tests prove the real thing, on a real emulator.

All four exit non-zero on any failure. `SMOKE_DEVICE` picks the device, default `emulator-5556`.

## pnpm smoke

It needs no browser. Through `@ariadne/core`, exactly as the server does, it records two cases on the Android Settings app, replays each with Maestro, writes `runs/<runId>/summary.json` and requires every step to pass.

1. **Case A** restarts the app and replays `blocks/open-settings.yaml` through agent-device inside the recording session. It then records Back (to the Settings home), Scroll down, a tap on a safe entry that was not on screen before the scroll ("System" when it is one of them; the log says so if it falls back to the first safe entry), a check on the page title, and Back, and finishes with the first end check candidate.
2. **A copy of case A's flow** with an `assertVisible` on a text that does not exist, inserted before the final Back. It requires exit code 1, that step reported as failed with Maestro's message and screenshot, and the Back after it as not run.
3. **Case B** has no block. Scroll down is the very first step after the app starts, then a tap on an entry the scroll revealed, then Back, finished with no end check. This is the case a plain Maestro `scroll` cannot run, see [Known limits](/reference/known-limits).

It leaves the emulator on the Settings home screen. Tap targets are chosen by reading the snapshot, never by coordinates.

Environment overrides:

| Variable | Default |
|---|---|
| `SMOKE_DEVICE` | `emulator-5556` |
| `SMOKE_PROJECT_DIR` | `workspace` in the repository |
| `MAESTRO_BIN` | as for the studio |
| `ANDROID_HOME` | `~/Android/Sdk` when it exists |
| `SMOKE_ATTEMPTS` | 2 |

If another process launches a different app on the emulator during a run, detected in logcat, the attempt is retried, because the emulator may be shared with other tools.

## pnpm smoke:studio

It drives the studio server in-process through the same API the UI uses, on a fresh temporary project (or `SMOKE_PROJECT_DIR`), with its own agent-device session, so a studio open on another device is left alone.

On the Settings app it:

- records a case with a block, and a second case that starts from the first
- edits the first by adding a check after step 1 and re-recording from step 3
- records a third case with typing, Hide keyboard and Relaunch app
- replays them with the per-step screenshot and similarity checks
- splits the second case
- runs Run all with retry and requires every case to pass
- checks the run report, the suite report, and the Excel, HTML and Markdown exports

## pnpm smoke:phone

Records from touches on the phone, through the server's API. It sends touches with `adb emu event send`, which reach `/dev/input` the way a finger does, so it needs an emulator: `adb shell input` never shows in `getevent`. It records tap, Back, swipes and text arriving in a field, runs the case with Maestro, then checks that leaving the app pauses recording and that the first step back is flagged.

## pnpm smoke:gestures

It drives the studio server the same way, with the agent-device session `smoke-gestures` (or `ARIADNE_SESSION_NAME`).

While not recording it uses Zoom in and Recent apps and checks they record nothing. While recording it checks both are refused.

Then it records a case on Settings: a swipe up and a swipe down, a long press on "Network & internet" (which opens it), a double tap on the page title, Back, Volume up, Rotate to landscape and back to portrait (checking the screen's shape each time), Home, Relaunch app, a tap on "Search settings", typing, Enter and Back.

It runs the case with Maestro and requires it to pass with a screenshot after every step but `launchApp`. Then it adds a check after the rotation back to portrait, which replays the first eight steps on the device (the swipes, long press and double tap through agent-device, Volume up and the rotations through the device session), and runs the case again.

The first swipe usually shows as "looks different": agent-device and Maestro do not scroll the list by exactly the same distance for the same drag.
