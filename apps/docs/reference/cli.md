---
title: CLI reference
description: The ariadne-studio command, its options, init, environment variables and exit codes.
---

# CLI

`ariadne-studio` starts Ariadne Studio on this machine and opens it in your browser, or adds Ariadne to an app repository.

```
ariadne-studio [project-folder] [options]
ariadne-studio init [folder]
```

## Options

| Option | Default | Environment |
|---|---|---|
| `[project-folder]` | see [Which folder it opens](#which-folder-it-opens) | `ARIADNE_PROJECT_DIR` |
| `-p, --port <n>` | 4711; 0 picks a free port | `PORT` |
| `--host <addr>` | 127.0.0.1 | `HOST` |
| `--no-open` | opens the browser | |
| `--session <name>` | `studio`; set another for a second studio on the same machine | `ARIADNE_SESSION_NAME` |
| `-h, --help` | shows the help | |
| `-v, --version` | shows the version | |

An argument wins over its environment variable.

## Which folder it opens

With a folder named, it opens that folder, or its `.ariadne` project when the folder has no `project.json` of its own and `.ariadne/project.json` exists.

With no folder named:

1. this folder, if it has `project.json` and `cases/`
2. else `./.ariadne`, if it has `project.json`
3. else `./ariadne`, created if missing

## init

```sh
ariadne-studio init [folder]
```

Adds Ariadne to an app repository, by default this folder. It creates `<folder>/.ariadne/` with `project.json`, `cases/` and a `.gitignore`, and points it at the repository's Maestro workspace when there is one. See [Use with an existing Maestro project](/guides/existing-maestro-project).

It refuses to replace an existing project: `<folder>/.ariadne/project.json already exists; this folder already has an Ariadne project. Nothing was changed.`

## Running

The studio starts on `http://127.0.0.1:4711` and prints the address and the project folder. Ctrl+C stops it and closes the device session. A second Ctrl+C while the session closes exits at once.

If the port is taken:

- by a studio on the same project, it opens that studio and exits with 0;
- by a studio on another project, or another program, it says so, prints the command for a second studio with another port and session, and exits with 1.

## Environment variables

| Variable | What it does |
|---|---|
| `ARIADNE_PROJECT_DIR` | the project folder, when none is named |
| `PORT` | the port, when `--port` is not given |
| `HOST` | the address, when `--host` is not given |
| `ARIADNE_SESSION_NAME` | the agent-device session name, when `--session` is not given |
| `MAESTRO_BIN` | where Maestro is, when it is not in the usual places |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | where the Android SDK is |
| `AGENT_DEVICE_STATE_DIR` | agent-device's state folder, default `~/.agent-device` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | stopped normally, or printed help or the version, or `init` finished, or the studio was already running for this project |
| 1 | the studio failed to start, the port is in use, or `init` refused |
| 2 | bad arguments, such as a port that is not a number or two project folders |
