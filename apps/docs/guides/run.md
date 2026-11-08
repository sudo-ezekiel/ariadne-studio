---
title: Run Maestro tests and retry flaky cases
description: "Run cases with Maestro: a screenshot after every step, failures retried, flaky cases tagged, screens compared, and reports to share."
---

# Run and Run all

Find out whether the app still does what you recorded, with a picture of every step to prove it.

## Run a case

**Run** on a case replays it with Maestro. The result is shown beside the recorded steps:

- passed, failed (with Maestro's message) or not run for each step
- how long each step took
- the recorded and the replayed screen side by side
- Maestro's screenshot of the failure

The header says "Last run passed" or "Last run failed" with the date. Earlier runs are in the list beside it.

![A failed run: the failing step in red with Maestro's message, the time of each step, and the steps that did not run](/shots/run-failed.png)

The device used is the open session's, else the project's last device, else the one the case was recorded on. A run has a limit of 5 minutes. Run blocks the studio until Maestro finishes.

## What a run does

Run closes the studio's device session, because Maestro brings its own UiAutomator driver and only one can own the device. It writes the case's flow, and the flows of the cases it starts from, from the case JSON. Then it runs a copy with a screenshot after every command:

```
maestro --device <serial> test --no-ansi --debug-output runs/<runId> --flatten-debug-output -e KEY=VALUE ... runs/<runId>/flow.yaml
```

The copy is `flows/<caseId>.yaml` plus `takeScreenshot: { path: after-NNN, optional: true }` after each command except `launchApp`, which returns before the app has drawn. Its `runFlow` paths point back into `flows/` and `blocks/`.

`flows/<caseId>.yaml` itself never contains screenshots, so it stays what developers and CI run.

The session is reopened afterwards without restarting the app.

## Looks different

Each replayed screen is compared with the one recorded for the same step, on a coarse grid that ignores the status and navigation bars and small vertical shifts. Below 85% alike the step is marked **looks different**.

This never fails a run; Maestro decides that. It points at screens worth a look, such as a dialog that appeared or a list that ended up somewhere else. Measured on Settings screens, the same screen on two different emulators scores 95 to 100, and different screens 79 or less.

A step whose screen legitimately changes, such as a date or a new banner, shows as different until it is re-recorded.

## When the device is to blame

When a run fails because of the device rather than the app, the result says so in plain words instead of blaming a step. That covers adb reporting the device offline, Maestro's driver dying or never starting, and no room to install the driver.

Both Run and Run all retry such a run once, and it does not count against the case.

## Run all

**Run all** replays every case that is not muted, one at a time, on the open session's device (else the last one used), parents before the cases that start from them.

With **retry failures once** ticked, the default, a failed case runs again. Failed then passed is reported as `flaky`.

It runs in the background. The panel shows progress, **Stop after this case** ends it early, and any request that would use the device is refused until it ends.

**Report** gives one HTML page with every case and the screenshot of each failure.

## Evidence pack

After Run all, **Evidence pack** makes the test results report for whoever accepts the release, such as a client, an acceptance committee or the person who approves releases.

It is off until you turn it on: open Settings (the gear at the top right) and tick **Offer an evidence pack after Run all**. The choice is saved as `evidencePack` in [`project.json`](/reference/project-json), so everyone who opens the project sees it. **Evidence pack** then appears after **Report** under the last Run all. Fill in:

- **Release**: what the release is called. It starts as the app version Run all read from the phone, such as `2.4.1 (241)`.
- **Tested by**: your name.
- **Second signature**: "Accepted by" unless you change it. When the client accepts in a document of its own, as a public acceptance committee does, write "Reviewed by" instead.
- **Screens**: after every step, or only after checks and after a step that failed. The second is shorter and shows less of what was on the screen.
- **Known issues** and **Conclusion**, in your own words. Left empty, they stay blank to write on paper.

The studio remembers your name, the second signature and the choice of screens.

**Make the pack** opens it in a new window. The first page is the one to sign:

- the release, the app and its version, and the device: a real phone or an emulator, its model and its Android version
- when Run all started and ended, whether failures were run again, and which screens are shown
- who tested, the result, your known issues and conclusion
- every case with its result, and its [reference](/guides/edit-and-chain#edit-a-case) when it has one
- a table for the two signatures
- the Run all file it summarises, with its SHA-256

After that, each case that ran has a page with every step, what it was expected to do, its result and the screen after it on this run. A step that failed shows the screen when it failed. Each page names the run's `summary.json` and its SHA-256.

**Print or save as PDF** at the top prints it, and the button itself stays off the paper. A copy is saved as `exports/evidence-<suiteId>.html`.

Times are in this computer's time zone, with its offset from UTC.

### Check a pack against the project

A SHA-256 is a fingerprint of a file: change one character and it changes. Anyone with the project folder can check that a pack matches the runs it describes:

```sh
sha256sum runs/_suites/<suiteId>.json          # Linux
shasum -a 256 runs/_suites/<suiteId>.json      # macOS
Get-FileHash runs\_suites\<suiteId>.json     # Windows PowerShell
```

### What a pack is and is not

A pack covers one Run all, and the versions in it are read when Run all starts. So install the build you mean to accept, run all, then make the pack. If a new build fixes a failure, run all again on it.

It is a record of what ran and what each step showed. In a public contract the acceptance itself is the committee's own protocol, and at a regulated company it is the approval in the change record, so attach the pack to those rather than send it in their place.

Like the reports, the pack shows whatever was on the screen. Use test accounts and test data, and look through it before you send it outside the company.

## History and flaky cases

A case's history counts only runs since its last edit, and leaves out runs lost to a device problem.

A case is `flaky` when those runs, the last ten, both passed and failed. It is `failing` when the newest one failed.

## Step timings

Each step in a run shows how long it took, in the result view and in the shareable report. Use it to find the step that makes a case slow. The times come from Maestro's `commands.json`.

## Reports

**Shareable report** writes `runs/<runId>/report.html`, a single file with every step, its result, its time and both screens inlined, for sending to a developer or attaching to a ticket. When the run has a [run video](/guides/run-video), the report links to it. The video stays a separate file, so send it along if the reader needs it.

![The shareable report of a failed run](/shots/run-report.png)

## Where runs go

`runId` is `<caseId>-<yyyymmdd-hhmmss>`. `runs/<runId>/` holds:

- `flow.yaml`, the copy Maestro ran
- Maestro's debug output: `maestro.log`, and in `<flow name>/` the `commands.json`, `logs/` and `takeScreenshot/after-NNN.png` files, with `screenshots/` and `screen-hierarchy/` on failure
- `output.txt`, Maestro's console output with env values replaced by `${KEY}`
- `summary.json`, which the studio reads
- `report.html`, once you asked for it
- `video.mp4`, when run video is on

Run all's result is in `runs/_suites/<suiteId>.json`. Each case run in it is an ordinary run.

The server logs one line when a run starts and one when it ends. It never logs the `-e` values.

## Privacy

Runs stay in `runs/` on your machine. After every run the studio replaces `.env` values with `${KEY}` in the text files Maestro wrote. Screenshots keep what was on the screen, so keep `runs/` out of version control. A new project's `.gitignore` already does.
