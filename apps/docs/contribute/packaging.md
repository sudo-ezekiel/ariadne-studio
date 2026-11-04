---
title: Packaging and releases
description: How the npm package and the Electron app are built from one bundle, and what a release needs.
---

# Packaging and releases

The npm package and the desktop app are thin wrappers around one bundle.

## The bundle

`apps/cli/build.ts` bundles the CLI, the server and `@ariadne/core`, with Fastify and the other server libraries, into `apps/cli/dist/cli.mjs` with esbuild, and copies the built UI to `apps/cli/dist/ui`.

Only `agent-device` stays a real dependency, because it hands its helper APKs to adb by path and starts its daemon from its own folder. The build fails if the bundle imports a package that is not in `dependencies`, and writes the licences of everything it inlined to `dist/THIRD_PARTY_LICENSES.txt`.

## npm

`apps/cli` is the npm package, `ariadne-studio`, because the `ariadne` name is taken on npm. `pnpm publish` in `apps/cli` rebuilds everything first, through `prepack`. The build copies the repository's `LICENSE` to `dist/LICENSE`, next to the third-party notices.

## Desktop

`apps/desktop` is an Electron app. Its main process starts `dist/cli.mjs --port 0 --no-open` as a child process with Electron's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), waits for the CLI's `ready` message over IPC and loads the URL in the window. It quits through the same message, so the device session is closed before the app exits.

Started from the Dock or a launcher, an app gets a bare `PATH`, so the main process adds the login shell's `PATH` and the usual adb and Maestro folders.

`pnpm desktop:dist` stages the bundle and a real copy of `agent-device` in `apps/desktop/stage/server` and runs electron-builder (`apps/desktop/electron-builder.yml`), which puts them in the app's `resources/server`.

`pnpm desktop:dist` builds for the system it runs on: the AppImage on Linux, the dmg on a Mac, the NSIS installer on Windows. `pnpm desktop:dist:win` builds the Windows installer from Linux too, through Wine, which electron-builder uses to set the exe's icon and version details.

Signing is not set up. macOS needs an Apple Developer ID and notarization, Windows a code signing certificate.

Running Electron from a terminal inside VS Code or another Electron-based editor inherits `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. `pnpm desktop` removes it (`apps/desktop/start.ts`).

## Windows and Maestro

On Windows the Maestro CLI is `maestro.bat`, which Node will only start through `cmd.exe`. A run passes the `.env` values as arguments, so `packages/core/src/replay/windows-command.ts` quotes and escapes each one for cmd.exe, twice, because `maestro.bat` hands `%*` to java on a line cmd.exe parses again. A run that times out is stopped with `taskkill /t`, so java does not outlive it.

## Before a release

Keep the versions in `apps/cli/package.json` and `apps/desktop/package.json` the same. The steps are in [docs/RELEASING.md](https://github.com/sudo-ezekiel/ariadne-studio/blob/main/docs/RELEASING.md). A `v*` tag builds the desktop app on Linux, Windows and macOS, attaches it to a draft GitHub release and packs the npm tarball. Publishing stays a manual step.
