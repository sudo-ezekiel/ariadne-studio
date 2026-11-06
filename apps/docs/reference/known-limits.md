---
title: Known limits
description: What Ariadne does not do yet, and the behaviour of Maestro and agent-device worth knowing.
---

# Known limits

What is not done, and what behaves in a way you might not expect.

## Platforms

- Android only.
- The desktop app is tested end to end on Linux. On one real Windows 11 computer with a POCO F5 Pro over USB, installing, connecting, recording taps and checks, and running a case with Maestro all worked. Typing, gestures and **Use the phone** have not been tried on Windows yet.
- The macOS build is configured but not built or tried.
- On one Windows computer, only one account whose user name Java cannot spell can use **Set up this computer**, because those tools live in one folder locked to that account. If PowerShell is blocked, Ariadne cannot check that folder and does not use it.
- On Windows, a project folder with letters the system code page cannot spell, such as a Greek user name on English Windows, runs fine. A folder with such letters inside the project, such as a flows folder of your own, stops Maestro at once: its Java receives that part of the path as question marks.

## One device at a time

- One device session at a time, and Run blocks the studio until Maestro finishes.
- Run all runs in the background but holds the device until it ends.

## Other apps and websites

- The screen in the studio is a new picture every few seconds, not video. It stops looking during an action, a run, the end check picker and **Use the phone**, and while the window is hidden. **Refresh** looks at once.
- A lit lock screen is found by asking Android. A phone that has never answered counts as unlocked, so its lock screen would show here. The POCO F5 Pro and the Android 16 emulator both answer.
- A step that needs the camera, such as a selfie or a photo of a document, cannot be replayed.
- A one-time code or a link made for one session is different on every run, so a step that depends on it fails on the next run.

## Using the phone

- Tested with real fingers on one phone, a POCO F5 Pro with HyperOS 3, and with simulated touches on the Android 16 emulator. Other phones report touches differently, so expect some to need work.
- It needs a phone you can touch. On a remote phone, such as Samsung's Remote Test Lab, clicks in the browser never reach the touchscreen, so nothing records. Record on the screen here instead; Connect, recording and Run all work over a remote link, though a run is slower.
- A tap on a value that changes, such as a calculated result, names that value, so the run fails once it differs. Tap the control instead, or a developer can add an id. This applies on the screen here too.
- Text longer than 80 characters is not used to find an element, so a card with a long label records a position. This applies on the screen here too.
- Gesture navigation is told apart by where the swipe starts. It has been run on the emulator; on a real phone it is unproven.
- Two quick taps on the same spot record as two taps, never as a double tap: a calculator's `7`, `7` looks the same as a double tap. Use the right click menu on the screen here for a real double tap.
- A flick records as a swipe at its speed, up to the limits of a swipe on the screen here, and the list may scroll a different distance on replay.
- The phone's screen is not mirrored live while you use it: the screen here updates about a second after each step.

## Scrolling and swiping

- Scroll down and Scroll up scroll the main list by about 60% of the screen height while recording.
- A swipe dragged on the screen replays by position, as percentages of the screen, not on an element. The same drag can scroll a list a slightly different distance under Maestro than it did while recording. Follow it with a tap or check on an element rather than a position.
- A scroll before a tap or check replays as `scrollUntilVisible` on that element, so a run does not depend on Maestro scrolling the same distance as agent-device, nor on the screen being drawn yet. Maestro waits and scrolls until the element is fully visible, 20 s by default.
- A scroll that no tap or check follows stays a plain `scroll`, which moves a fixed distance and does not wait. Measured on the Settings app, a plain `scroll` straight after `launchApp` runs before the list is drawn and scrolls nothing.

## Secrets in run output

After every run the studio replaces `.env` values with `${KEY}` in the text files of the run folder, including Maestro's `maestro.log` and `commands.json`. `output.txt` and `summary.json` are clean too. Three things it does not cover:

- values shorter than 4 characters, because replacing them would corrupt ordinary text;
- pictures: screenshots and [run videos](/guides/run-video) keep whatever the screen showed;
- Maestro's own default output under `~/.maestro/tests`, outside the project.

Keep `runs/` out of version control. A new project's `.gitignore` does.

## Keyboard

The studio keeps the device's real keyboard, which agent-device would otherwise swap for a headless one, because Maestro runs with the real keyboard and Back behaves differently when a keyboard is showing.

## Blocks

- A block that needs Maestro makes starting, re-recording or running it mid-case take as long as a Maestro run, typically 10 to 20 seconds on an emulator.
- agent-device 0.21.35 reports success for some commands it does not really run: it "replayed" a `runScript` block. That is why the studio decides from the file, not from trying agent-device first.
- agent-device must use its shared daemon for block replay to run inside the studio's session. The studio passes agent-device's default state directory explicitly (`AGENT_DEVICE_STATE_DIR`, else `~/.agent-device`). Without it, agent-device runs a replay in a private one-shot daemon that cannot use the device the studio holds.

## Looks different

The score is a coarse picture comparison, and a run still follows the recorded selectors. A step whose screen legitimately changes, such as a date or a new banner, shows as different until it is re-recorded.

## Chains

A case runs the flow of the case it starts from in full, end checks included, so a long chain replays every parent each time. Split long cases where a shared starting point makes sense.

## Open link

Open link sends Android's VIEW intent through adb while recording, the same intent Maestro's `openLink` sends on a run, so the device opens the link with whatever app handles it. agent-device alone can only open links inside the app under test. Checked on the emulator with a web link: both end in Chrome. The link is quoted for the device shell and must look like `scheme://...`.

## A tap on a page that is still loading

Maestro can find a link on a web page before the page is ready to follow it. The tap then does nothing and Maestro still reports it as completed, so the run fails at the next step, or passes if no step comes after the tap.

On a POCO F5 Pro, a recorded tap on gov.gr did nothing up to 8 seconds after the page opened, and worked from about 16 seconds. `waitForAnimationToEnd` did not help, and an emulator passed the same flow with no pause, so an emulator does not show this.

Add a **Wait** before the tap, and a check after it, so that a tap that did nothing fails where you can see it. How long a page needs depends on the phone and the network.

## Run video

Android's screen recorder may stop at 3 minutes on a long run, and a run can last 5 minutes.

The steps beside the phone need `ffmpeg`, and they are drawn in Noto Sans Mono: step names in scripts other than Latin, Greek and Cyrillic show as boxes.
