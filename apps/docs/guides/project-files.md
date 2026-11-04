---
title: "Project files: flows, cases and evidence"
description: The Ariadne project folder, the Files sidebar, what to commit, and how .env works.
---

# Your project files

Everything Ariadne makes is an ordinary file in one folder, so you can read it, commit it and hand it over.

The project folder is `Documents/Ariadne` for the desktop app, the folder you name for the npm package, and `workspace/` with `pnpm dev`. See [Install and set up](/guides/install).

## The folder

```
project.json          app id and settings
.env                  saved values as KEY=VALUE; never committed
.gitignore            .env, evidence/, runs/ and exports/; written into a new project folder
blocks/               setup blocks: Maestro flows written by developers, such as login.yaml
flows/<caseId>.yaml   one Maestro flow per case, regenerated on every save
cases/<caseId>.json   the case itself: blocks, steps, selectors, element details, screenshot paths, end checks
evidence/<caseId>/    step-001.png, step-002.png, ... taken after each recorded step
runs/<runId>/         flow.yaml (the copy Maestro ran), Maestro's debug output with
                      takeScreenshot/after-NNN.png, output.txt, summary.json and, once asked
                      for, report.html; video.mp4 when run video is on
runs/_suites/         one JSON file per Run all
runs/_partial/        the start of a case being replayed to record from it; deleted afterwards
exports/              test case documents: <caseId>.xlsx/.html/.md, test-cases.xlsx/.html/.md
```

`caseId` is the case name as a slug plus a timestamp, for example `open-network-settings-20261030-1712`.

The case JSON is the source of truth. The YAML is generated from it, and Run writes it again if it is missing.

`paths` in [`project.json`](/reference/project-json) moves `blocks/` and `flows/` out of the project folder, for a project kept beside an existing Maestro workspace.

## The Files sidebar

The Files sidebar on the right of the studio shows the project folder as it is on disk, plus any block or flows folder that `paths` keeps outside it, under its relative path. It is open by default.

![The Files column open in the dark theme, with a flow open in its own tab beside Record and Cases](/shots/files-sidebar.png)

Click a file to open it in its own tab beside Record and Cases. Closing the tab goes back to where you were.

- YAML, JSON, logs and other text open as text, showing the first 512 KB of a longer file.
- Screenshots open as images.
- Excel documents and other binary files show only their size.

The sidebar is read only, and it refreshes after every save and run. To edit a block, use your editor. Do not edit a file in `flows/`, because the next save regenerates it from the case.

Hide or show the column with the button in the top bar. The studio remembers the choice.

`.env` files never appear and the server refuses to open them. `.git` and `node_modules` are hidden too.

## What to commit

| Commit | Leave out |
|---|---|
| `project.json` | `.env` |
| `cases/` | `runs/` |
| `flows/` | `evidence/`, unless the team wants the screenshots in the repository |
| `blocks/` | `exports/` |

A new project folder gets a `.gitignore` that leaves out the right-hand column.

Cases belong in version control as well as flows: without `cases/` the studio has nothing to edit, and the next save has nothing to regenerate the flow from. Screenshot paths in the case JSON point at `evidence/`, so a teammate without that folder sees cases with no thumbnails. To share them, take `evidence/` out of the `.gitignore`.

## The .env file

`.env` holds saved values, one `KEY=VALUE` per line:

```
# Test users
USERNAME=ba@example.com
PASSWORD="two words"
```

Blank lines and `#` comments are ignored, a value may be wrapped in single or double quotes, and a line may start with `export `. There is no interpolation.

Values that are not secret can also go in `project.json` as `env`. `.env` wins on conflicts.

The studio passes every key to Maestro as `-e KEY=VALUE` on a run, and to a block before recording. Flows and cases hold only the `${KEY}` references.

[Test users](/guides/test-users) are saved values with a prefix, added from the studio.

## Privacy

Nothing in this folder leaves your machine unless you commit or send it. `.env` is never shown in the Files sidebar and is never returned by the studio's API.
