# Changelog

All notable changes to Ariadne Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  (Samsung Galaxy A16). The Windows build has only run under Wine, and a macOS build is configured
  but has never been built.

[0.1.0]: https://github.com/sudo-ezekiel/ariadne-studio/releases/tag/v0.1.0
