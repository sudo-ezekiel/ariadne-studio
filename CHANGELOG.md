# Changelog

All notable changes to Ariadne Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Wait until**, beside Check: click something on the screen, and a run waits up
  to 20 seconds for it to appear, and fails on that step if it never does. Use it before a tap on a
  page that is still loading instead of guessing a number of seconds. The block form offers it too.
- **Remove step** while recording, from a step's menu or with Delete, with **Undo** in the message
  after it. A note above **Finish recording** says when a removed step had acted on the phone.
- A **Wait** tile at the end of the steps: drag it between any two steps, or press **Add**. Every
  step's menu has **Add a wait after this step**, and a wait's seconds can be changed in its row.
- Type straight into the screen: click a field and a text box appears over it. Press Enter to send
  the text as one type step; a click elsewhere on the screen sends it first. Over a password field
  the box shows dots. The **Text to type** box under the screen stays for fields that do not
  report their focus, such as those in web pages.
- Saved cases can take a wait after any step, or before step 1, and change its seconds, without
  recording again.

### Changed

- Step lists are drawn as one thread with a mark on it for each row: a ring for a step, a green
  ring for a check, a violet square for a block, a dotted stretch for a wait. The cards with a
  coloured edge are gone from the steps, the setup blocks, the block form and the messages.
- A saved case numbers its rows by step, so step 3 in the list is the step 3 its menu talks about.
- Refresh under the screen is an icon at the end of the second row.
- Wait left the controls under the screen; the Wait tile at the end of the steps and the row menu
  add one where you want it.
- A step's result reads as a word in its colour, with a tick for Passed and a cross for Failed, and
  "flaky", "failing" and "muted" are plain words: no more pills. While recording, only the bar
  above the screen says so, and the Set up a device dialog's headings are no longer in capitals.
- **Check** and **Wait until** moved from under the screen to the end of the steps, beside the
  **Wait** tile, so everything that adds a step without tapping is in one place. Right-clicking the
  screen still offers Check.
- No more **Use the phone** button. While recording, touch the phone and the studio follows it
  (the bar says **Following the phone**); click the screen here and it carries on from there,
  writing text typed on the phone as its step first. **Record what I do on the phone itself** in
  Settings turns this off on this computer.

### Fixed

- Recording on the phone itself: a password typed into a field that shares its id with the field
  before it, as every React Native Elements input does, became "erase" steps and no `${PASSWORD}`,
  so the block or case failed on its run.
- A step recorded from the phone shows an empty frame until its screenshot is taken, instead of a
  broken picture.

## [0.1.2] - 2026-11-08

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

### Fixed

- On Windows, saving a project file failed when something was reading it at that moment, such as a
  virus scan. The end of a Run all could then stay saved as "running". The studio now tries again
  for about 2 seconds, and saves of one file wait their turn so a later one is never overwritten
  by an earlier one.

### Known limits

- The Blocks tab and the evidence pack were tried on an Android emulator, not yet on a real phone.
  Recording with a phone on Windows is still unconfirmed.

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

[0.1.2]: https://github.com/sudo-ezekiel/ariadne-studio/releases/tag/v0.1.2
[0.1.1]: https://github.com/sudo-ezekiel/ariadne-studio/releases/tag/v0.1.1
[0.1.0]: https://github.com/sudo-ezekiel/ariadne-studio/releases/tag/v0.1.0
