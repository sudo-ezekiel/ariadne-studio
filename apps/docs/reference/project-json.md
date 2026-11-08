---
title: project.json reference
description: Every field of an Ariadne project's project.json, including paths, runVideo and evidencePack.
---

# project.json

`project.json` sits in the project folder and holds its settings. It is meant to be committed. The studio creates it, and Connect updates `appId` and `lastDeviceId`.

```json
{
  "appId": "com.example.app",
  "platform": "android",
  "lastDeviceId": "emulator-5554",
  "env": {
    "BASE_URL": "https://staging.example.com"
  },
  "paths": {
    "blocks": ["../.maestro/subflows"],
    "flows": "../.maestro/recorded"
  },
  "runVideo": true,
  "evidencePack": true
}
```

## Fields

| Field | Type | Required | What it does |
|---|---|---|---|
| `appId` | string | yes | The app under test. Prefills the App id field. Empty in a new project. |
| `platform` | `"android"` | yes | The only platform there is. |
| `lastDeviceId` | string | no | The last device connected. Run and Run all use it when no session is open. |
| `env` | object of strings | no | Saved values that are not secret. `.env` wins on conflicts. |
| `paths` | object | no | Where blocks and flows live, see below. |
| `runVideo` | boolean | no | [Keep a video of each run](/guides/run-video). Off unless set. |
| `evidencePack` | boolean | no | [Offer an evidence pack after Run all](/guides/run#evidence-pack). Off unless set. |

## paths

`paths` moves blocks and flows out of the project folder, for a project kept beside an existing Maestro workspace. Both are relative to the project folder.

| Key | Default | What it is |
|---|---|---|
| `blocks` | `["blocks"]` | A list of folders. Every `*.yaml` and `*.yml` file directly in each one is a block, named by its path from the project folder, such as `../.maestro/subflows/login.yaml`. |
| `flows` | `"flows"` | The folder case flows are written to. |

Leave either out for `blocks/` or `flows/` in the project folder. Everything else stays in the project folder: `cases/`, `evidence/`, `runs/`, `exports/` and `.env`.

The studio reads `paths` when it starts, and creates only the folders inside the project.

A malformed value stops the project from opening, with one of these messages:

- `project.json: "paths" must be an object such as { "blocks": ["../.maestro/subflows"], "flows": "../.maestro/recorded" }.`
- `project.json: "paths.blocks" must be a list of folders, such as ["../.maestro/subflows"].`
- `project.json: "paths.flows" must be a folder, such as "../.maestro/recorded".`

## Project folders

An existing project is a folder with `project.json` and `cases/`. Opening a folder without them creates the layout, with a `.gitignore` when it is a new project and none is there.
