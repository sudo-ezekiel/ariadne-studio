---
title: Develop Ariadne from the repository
description: Run Ariadne from source, the pnpm commands, and how the repository is laid out.
---

# Develop from the repository

Everything here is for working on Ariadne itself. To use it, see [Install and set up](/guides/install).

## Start

The [prerequisites](/guides/install#prerequisites) apply, plus pnpm 11. `corepack enable` picks up the pinned version.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the API server on `http://127.0.0.1:4711` and the Vite UI on `http://localhost:5173`, which proxies `/api` to the server.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over every package and the scripts |
| `pnpm test` | vitest unit tests (core) and server tests with a fake device and a fake Maestro (studio) |
| `pnpm build` | builds the UI into `apps/studio/dist/ui`, the npm package into `apps/cli/dist` and the desktop main process into `apps/desktop/dist` |
| `pnpm start [projectDir]` | runs the server alone; it serves the built UI on port 4711 |
| `pnpm cli [options]` | builds and runs the npm package's `ariadne-studio` command, see [CLI](/reference/cli) |
| `pnpm desktop` | builds and opens the desktop app from source |
| `pnpm desktop:dist` | builds the desktop installer for this system into `apps/desktop/release/` |
| `pnpm desktop:dist:win` | builds the Windows installer; on Linux it needs Wine |
| `pnpm smoke` | end-to-end proof of recording and replay on a real device, see [Smoke tests](/contribute/smoke-tests) |
| `pnpm smoke:studio` | end-to-end proof of the studio through the server's API |
| `pnpm smoke:gestures` | end-to-end proof of gestures and phone buttons through the server's API |
| `pnpm smoke:phone` | end-to-end proof of recording from touches on the phone; needs an emulator |
| `pnpm docs:dev` | serves these docs with live reload |
| `pnpm docs:build` | builds these docs into `site/docs/` |

## Project folder

The server takes the project directory as its only argument, default `./workspace`. With `pnpm dev`, set `ARIADNE_PROJECT_DIR=/path/to/project` instead.

In this repository only `workspace/project.json` and `workspace/blocks/*.yaml` are tracked. Everything else under `workspace/` is ignored.

## A second studio

`PORT` changes the API port, and the Vite proxy follows it. A second studio on the same machine needs another `PORT`, another Vite port (`pnpm --filter @ariadne/studio exec vite --port 5174`), and `ARIADNE_SESSION_NAME` set to something other than `studio`, because agent-device sessions are shared by name across the machine.

## Repository layout

```
packages/core     recorder, Maestro model and emitter, project store, replay, exports
apps/studio       the server and the React UI
apps/cli          the ariadne-studio npm package
apps/desktop      the Electron app
apps/docs         this site, built with VitePress
site/             the landing page; the docs build lands in site/docs/
scripts/          the smoke tests, and capture/ for the site's footage
workspace/        the development project
docs/             internal design documents: spec, brand, plans
assets/           the logo
```

## These docs

The pages are Markdown in `apps/docs`, with the navigation in `apps/docs/.vitepress/config/navigation/`. Dead links fail the build.

The site is built with `base: '/docs/'`, so `site/` deploys as static files with the landing page at the root. `site/docs/` is build output and is not committed. The build also writes `llms.txt`, `llms-full.txt` and a `.md` twin of every page.

Keep to the words in `docs/brand.md`, and use the same shape on every guide: one line of why, the how, where the files go, and a privacy line where it matters.
