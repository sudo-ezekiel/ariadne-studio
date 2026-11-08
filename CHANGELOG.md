# Changelog

All notable changes to Ariadne Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Blocks** tab: write, edit, try and delete setup blocks in a form, with no YAML and no developer.
  A step's element can be picked on the screen, and any text in a step can be a setting that each
  case chooses. A block written here is an ordinary Maestro file in `blocks/`.
- **Record steps** fills a block by using the app, with the same end checks as a case. A password
  typed into a password field is not kept: its step becomes a setting.
- **Save as block** opens a saved case in the form as a new block. A case it starts from is written
  out in full, so the block stands alone.
- **Evidence pack** after Run all, off until **Offer an evidence pack after Run all** is ticked in
  Settings: a test results report for whoever accepts the release. The first
  page names the release, the app version, the device Run all ran on (real phone or emulator), who
  tested, every case's result, your known issues and conclusion, and the SHA-256 of the run records,
  with a table to sign whose second role you choose. Then each case has a page with every step, its
  expected result and the screen after it, or only checks and failures. Print it or save it as PDF;
  a copy goes in `exports/`.
- **Add a reference** under a case's name: a requirement, user story or scenario code, shown in test
  case documents and evidence packs.

### Changed

- The studio no longer says to ask a developer about a block's missing values. Save them under
  **Settings** in the Blocks tab.

## [0.1.1] - 2026-11-06

### Added

- **Set up this computer**: on Windows x64, Device setup fetches the Android tools, Java and Maestro
  itself, with no admin rights, no Android Studio and no change to `PATH`. Each download is pinned
  to a version and a SHA-256, and is started once to see that it runs.
- Device setup is a walkthrough: one step at a time, moving on by itself, and it opens by itself
  the first time. A phone that stays on "Allow USB debugging?" gets the fix after 30 seconds.

- The screen in the studio follows the phone by itself, so a handover to a website or another app,
  or a phone closed by hand, shows up without a click. **Refresh** looks at once.
- A note above the screen when another app or the home screen is in front. The app id is where a
  case starts, not a limit.
- Screens that block screenshots, as banks and ID apps often do, show their text and buttons over
  the black picture.
- **Wait** makes a run pause at a point in a case. A tap on a web page that is still loading does
  nothing, and Maestro still reports it as completed.

### Changed

- Device setup leads with a phone over USB. The checks and the manual steps for a phone and an
  emulator moved under All checks and manual steps.
- The Windows guide asks for the phone maker's USB driver only if the phone does not show up. A POCO
  F5 Pro needed none.

### Fixed

- Starting on a computer without adb no longer shows a raw `TOOL_MISSING` error.
- On Windows, Run works from a project folder the system code page cannot spell, such as a Greek
  user name on English Windows. Java used to receive the path as question marks.
- On Java 17, Greek and other text outside the system code page came out of Maestro as question
  marks, which also kept such a `.env` value from being redacted.
- The end checks on offer stay the same while the screen moves on behind the picker.
- When a user name has letters Java cannot spell, the tools go in `%ProgramData%\Ariadne`. That folder
  is now locked to your account, and nothing runs from it if another account could change it.
- A phone that is asleep or locked no longer records blind steps. Nothing is pressed or recorded, the
  studio says why, and the screen comes back by itself. Secure screens, which are black in a
  screenshot but still show their elements, record as before.
- The lock screen and its notifications are no longer shown in the studio or kept as a step's
  picture, and **Use the phone** pauses on it, so a PIN never becomes steps. A phone that stops
  saying whether it is locked counts as locked until it answers again.

## [0.1.0] - 2026-11-04

The first release. Android only.

### Added

- Recording on a mirrored phone or emulator screen: tap, long press, double tap, swipe, typing,
  scroll, the phone buttons, Relaunch app, Hide keyboard and Open link. Every step gets a selector
  and a screenshot.
- **Use the phone**: record from touches on the phone itself, with a note on any step that needs
  a look. Keyboard touch positions are never logged or stored.
- Check mode and end checks.
- Plain Maestro YAML, one flow per case, regenerated on every save.
- Setup blocks: Maestro flows a developer writes, run before a recording or in the middle of one,
  with test users and saved values from `.env` passed as `${KEY}`.
- Editing a saved case: rename, duplicate, delete a step, mute, re-record from a step, add steps in
  the middle, split, and start one case from the end of another.
- Run and Run all with the Maestro CLI: a screenshot after every step, step timings, "looks
  different" screens, retry of failures, flaky tags and run history.
- Shareable run reports, an optional run video, and test case documents in Excel, HTML and Markdown.
- Existing Maestro projects: `ariadne-studio init` adds Ariadne beside a `.maestro` folder.
- **Device setup**, with checks for adb, devices, emulators, Maestro and Java, and **Export
  diagnostics** to save one file for support.
- **Prepare this phone** for Xiaomi, Redmi and POCO phones, and plain messages when a phone maker's
  restrictions stop an install or a run.
- A light and a dark theme, and a Files sidebar.
- The `ariadne-studio` npm package and an Electron desktop app, with Linux AppImage and Windows
  NSIS builds. The desktop builds are not code signed.

### Known limits

- Tested with real fingers on one phone (POCO F5 Pro, HyperOS 3) and over a remote link on one
  (Samsung Galaxy A16). On real Windows the tests and a start with no phone pass in CI, and
  recording with a phone there is unconfirmed. There is no macOS build.

[0.1.1]: https://github.com/sudo-ezekiel/ariadne-studio/releases/tag/v0.1.1
[0.1.0]: https://github.com/sudo-ezekiel/ariadne-studio/releases/tag/v0.1.0
