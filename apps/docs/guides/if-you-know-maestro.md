---
title: Ariadne for Maestro users
description: Ariadne for Maestro users. The vocabulary table, record versus maestro record, artifacts, privacy and links to Maestro's docs.
---

# If you know Maestro

Ariadne is a recorder that writes Maestro Flows and runs them with the Maestro CLI. This page maps what you know onto what it does.

Everything Ariadne records is an ordinary Flow. Setup blocks are ordinary subflows. There is no runtime, format or service of its own between you and `maestro test`.

## Vocabulary

The studio's words are written for a BA. These docs use Maestro's words on developer pages where Maestro's thing is meant. This table is the one place both meet.

| Ariadne, in the studio | Ariadne, developer docs | Maestro |
|---|---|---|
| case | case; its flow | Flow |
| step | step; the emitted command | command |
| check | check (`assertVisible`) | assertion |
| setup block | block, a subflow in `blocks/` | subflow, `runFlow` |
| test user, saved value | `.env` key, `-e KEY=VALUE` | env, `-e` |
| project folder | project (`.ariadne/`) | workspace (`config.yaml`) |
| Run, Run all | run | `maestro test` |
| run video | `startRecording` / `stopRecording`, then `ffmpeg` | The same layout as `maestro record`, made another way |
| Record, Start recording | record steps | no equivalent; Maestro Studio adds commands by right-click |

## Record and maestro record

In Maestro, `maestro record` renders a video of a Flow that already exists. In Ariadne, recording writes the Flow, from your clicks: every tap becomes a command with a selector and a screenshot.

A video of each run is optional in Ariadne and has its own name, [run video](/guides/run-video). It has the layout of a `maestro record` video, the steps beside the phone, and it is made differently: `startRecording` and `stopRecording` in a copy of the Flow capture the phone, and `ffmpeg` adds the steps once the run ends. That keeps the run itself as the source of the video, so a failed run has one too. Ariadne never calls `maestro record`.

Maestro's pages: [Record your Flow](https://docs.maestro.dev/maestro-flows/workspace-management/record-your-flow), [startRecording](https://docs.maestro.dev/reference/commands-available/startrecording), [stopRecording](https://docs.maestro.dev/reference/commands-available/stoprecording).

## Workspaces

`npx ariadne-studio init` detects `.maestro/` or a `config.yaml`, writes recorded Flows to `.maestro/recorded/`, and uses the workspace's subflow folders as blocks. Add `recorded/*` to `flows:` in `config.yaml` to include them in a workspace run. See [Use with an existing Maestro project](/guides/existing-maestro-project) and Maestro's [workspace configuration](https://docs.maestro.dev/reference/workspace-configuration).

## What the Flows look like

Flows use a small part of Maestro's commands, listed in [How a case becomes a flow](/reference/case-to-flow), with selectors chosen by [these rules](/reference/selectors). Blocks can use anything Maestro runs: commands outside Ariadne's subset make the block [run with Maestro](/guides/setup-blocks#blocks-that-run-with-maestro) during recording too.

Case Flows are generated, so edit the case in the studio. Put Flows you want to own by hand in a block folder. A hand edit to a file in the flows folder is lost on the next save or run.

## Artifacts

Every run keeps Maestro's own output in `runs/<runId>/`, because the studio passes `--debug-output runs/<runId> --flatten-debug-output`:

| File | From | Holds |
|---|---|---|
| `flow.yaml` | Ariadne | the run copy: your Flow plus `takeScreenshot` commands |
| `maestro.log` | Maestro | the debug log |
| `<flow name>/commands.json` | Maestro | every command, with status and duration |
| `<flow name>/logs/` | Maestro | logs |
| `<flow name>/takeScreenshot/after-NNN.png` | Maestro | the screenshot after each step |
| `<flow name>/screenshots/` | Maestro | screenshots on failure |
| `<flow name>/screen-hierarchy/` | Maestro | the view hierarchy on failure |
| `output.txt` | Ariadne | Maestro's console output, `.env` values replaced |
| `summary.json` | Ariadne | the results the studio shows |
| `report.html` | Ariadne | the shareable report, once asked for |
| `video.mp4` | Maestro | the run video, moved here when it is on |

The studio does not read `testOutputDir` from `config.yaml`, and it passes no `--format`. For JUnit, run `maestro test` yourself, see [CI](/guides/ci). Maestro's page on [test reports and artifacts](https://docs.maestro.dev/maestro-flows/workspace-management/test-reports-and-artifacts) covers the flags.

## Privacy

Ariadne runs locally. The studio has no account and no cloud service, and it uploads nothing. Run video uses `startRecording`, which saves the file with the run.

Ariadne does not use `maestro record`. Without `--local`, that command sends the screen capture and the Flow's output to mobile.dev to render the video, as Maestro's page describes.

The Maestro CLI has its own analytics. To turn them off, set `MAESTRO_CLI_NO_ANALYTICS=true` in the environment you start the studio from, which Maestro inherits. See Maestro's [environment variables](https://docs.maestro.dev/maestro-cli/environment-variables).

After each run the studio replaces `.env` values in Maestro's text output with `${KEY}`. See [Known limits](/reference/known-limits) for the exceptions.

## Maestro's documentation

- [Getting started](https://docs.maestro.dev/get-started)
- [Commands and Flow syntax](https://docs.maestro.dev/reference)
- [runFlow](https://docs.maestro.dev/reference/commands-available/runflow) and [nested Flows](https://docs.maestro.dev/maestro-flows/flow-control-and-logic/nested-flows)
- [CLI commands and options](https://docs.maestro.dev/maestro-cli/maestro-cli-commands-and-options)

Maestro is a mobile UI testing framework by mobile.dev. These links are plain references, and Ariadne is not affiliated with mobile.dev.
