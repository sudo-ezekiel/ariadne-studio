---
title: Use with an existing Maestro project
description: Add Ariadne beside a .maestro folder. Your subflows become setup blocks and recorded flows land in your workspace.
---

# Use with an existing Maestro project

Keep the Maestro tests you have, and let the people who know the product add to them.

If the app's repository already has Maestro tests, typically a `.maestro/` folder with shared subflows such as `.maestro/subflows/login.yaml`, Ariadne can live beside them and use those subflows as its blocks.

## Add Ariadne

From the repository root:

```sh
npx ariadne-studio init
```

`init` creates `.ariadne/` as the project folder, with `project.json`, `cases/` and a `.gitignore` for `.env`, `evidence/`, `runs/` and `exports/`.

When it finds a Maestro workspace, it also:

- sets `appId` to the one most of the workspace's flows use,
- sets `paths.flows` to `../.maestro/recorded` and creates that folder, so recorded cases sit next to the team's own flows,
- sets `paths.blocks` to the workspace's `subflows`, `shared`, `common`, `helpers` and `utils` folders that exist, in any letter case.

With none of those folders, edit `paths.blocks` in `.ariadne/project.json` to point at the folders that hold your subflows.

A workspace is `.maestro/`, or else the repository root or a direct subfolder with a Maestro `config.yaml`.

`init` prints what it created and the command to run next, and refuses to touch a folder that already has `.ariadne/project.json`.

Then run `npx ariadne-studio` in the repository root, and it opens the `.ariadne` project. In the desktop app, open the repository root.

## What you get

```json
{
  "appId": "com.example.app",
  "platform": "android",
  "paths": {
    "blocks": ["../.maestro/subflows"],
    "flows": "../.maestro/recorded"
  }
}
```

The Files sidebar shows these folders too, under their relative paths.

![The studio on an adopted repository: Files shows .maestro/subflows and .maestro/recorded, and a recorded flow is open in a tab](/shots/existing-project.png)

## Recorded flows

Recorded flows are written to `.maestro/recorded/<caseId>.yaml` and refer to the blocks by their path from there (`runFlow: ../subflows/login.yaml`). So these run from the repository root:

```sh
maestro test .maestro/recorded/<caseId>.yaml   # one case
maestro test .maestro/recorded                 # all of them
```

Maestro runs only the top level of a workspace folder unless its `config.yaml` lists more. To include recorded flows in `maestro test .maestro`, add `"recorded/*"` to the `flows:` list there:

```yaml
flows:
  - "*"
  - "recorded/*"
```

The studio writes nothing else into `.maestro/`, and deletes only the `<caseId>.yaml` of cases it owns.

## Subflows as blocks

Subflows that use commands outside Ariadne's subset (`runScript`, `evalScript`, conditions, `onFlowStart` and so on) are usable. They run with Maestro, see [Blocks that run with Maestro](/guides/setup-blocks#blocks-that-run-with-maestro).

## What to commit

Commit `.ariadne/project.json`, `.ariadne/cases/` and `.maestro/recorded/`.

The screenshots in `.ariadne/evidence/` are ignored by default. Take `evidence/` out of `.ariadne/.gitignore` if the team wants them in the repository.

## Values

Put the values the subflows read (`${USERNAME}` and so on) in `.ariadne/.env`. Your CI keeps passing them as `-e KEY=VALUE` as it does today. See [CI](/guides/ci).

## Privacy

`.env`, screenshots, runs and exports stay in `.ariadne/` and out of version control by default. Only `.ariadne/project.json`, cases and flows reach the repository, and they hold references to values, never the values.
