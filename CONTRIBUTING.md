# Contributing to Ariadne Studio

Thanks for helping. Bug reports, phone reports and pull requests are all welcome. For a large
change, open an issue first so we can agree on the approach. By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Report a vulnerability through [SECURITY.md](SECURITY.md),
never in a public issue.

Ariadne has been tested on very few real phones, so a
[phone report](https://github.com/sudo-ezekiel/ariadne-studio/issues/new?template=phone_report.yml)
is as useful as code. No development setup is needed for one:
[Test on your phone](apps/docs/guides/test-on-your-phone.md) walks through it.

## Set up

You need Node 22.12 or newer and pnpm 11. `corepack enable` picks up the version pinned in
`package.json`.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the API server on http://127.0.0.1:4711 and the Vite UI on
http://localhost:5173. To use a real device you also need `adb`, and for Run, the Maestro CLI
and Java 17 or newer. See [Install and set up](apps/docs/guides/install.md).

The server takes the project folder as its only argument, default `./workspace`. With
`pnpm dev`, set `ARIADNE_PROJECT_DIR=/path/to/project` instead. A second studio on the same
computer needs another `PORT`, another Vite port and another `ARIADNE_SESSION_NAME`. In this
repository only `workspace/project.json` and `workspace/blocks/*.yaml` are tracked.

## Check your work

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over every package and the scripts |
| `pnpm test` | vitest: unit tests, and server tests with a fake device and a fake Maestro |
| `pnpm build` | builds the UI, the npm package into `apps/cli/dist` and the desktop main process |
| `pnpm cli [options]` | builds and runs the `ariadne-studio` command |
| `pnpm desktop` | builds and opens the desktop app from source |
| `pnpm desktop:dist` | builds the desktop installer for this system into `apps/desktop/release/` |
| `pnpm docs:dev`, `pnpm docs:build` | serves the docs, or builds them into `site/docs/`; dead links fail the build |

CI runs `pnpm typecheck` and `pnpm test` on every pull request. They need no device.
`apps/desktop/test/server-process.test.ts` fails now and then, because it can read the log file
before the write has reached the disk. If only that test fails, run it again.

### Smoke tests

The unit tests use a fake device and a fake Maestro. The smoke tests prove the real thing, so
they need a running device and do not run in CI. Each exits non-zero on any failure.
`SMOKE_DEVICE` picks the device (default `emulator-5556`).

| Command | What it proves | Needs |
|---|---|---|
| `pnpm smoke` | recording and replay through `@ariadne/core`, including a failing flow | device or emulator |
| `pnpm smoke:studio` | blocks, start from, edits, Run all, reports and exports through the server's API | device or emulator |
| `pnpm smoke:gestures` | gestures, phone buttons and live-only controls through the server's API | device or emulator |
| `pnpm smoke:phone` | recording from touches on the phone through the server's API | emulator: touches are sent with `adb emu event send` |

Run the one closest to your change if you have a device, and say in the pull request whether
you did. Details are in [Smoke tests](apps/docs/contribute/smoke-tests.md).

## How the packages fit together

```
packages/core     recorder, Maestro model and emitter, project store, replay, exports
apps/studio       the Fastify server and the React UI
apps/cli          the ariadne-studio npm package
apps/desktop      the Electron app
apps/docs         the documentation site (VitePress)
site/             the landing page; the docs build lands in site/docs/, which is not committed
scripts/          the smoke tests, and capture/ for the site's footage
workspace/        the development project
docs/             the design spec, the brand guide and the release checklist
assets/           the logo
```

`@ariadne/core` has no UI and no HTTP, so it can be tested alone. It wraps
[agent-device](https://agent-device.dev), which drives the phone while recording, and it starts
the Maestro CLI for runs. `@ariadne/studio` is one server process holding one device session,
plus a React UI that talks to it over `/api`.

The npm package and the desktop app are thin wrappers around one bundle:
`apps/cli/build.ts` bundles the CLI, the server and core into `apps/cli/dist/cli.mjs`, and only
`agent-device` stays a real dependency, because it reads its own files from its install folder.
`apps/desktop` runs that bundle as a child process. See
[Packaging and releases](apps/docs/contribute/packaging.md) and
[docs/RELEASING.md](docs/RELEASING.md).

The design and the reasons behind it are in [docs/spec.md](docs/spec.md). The product name,
palette and UI words are in [docs/brand.md](docs/brand.md).

## Conventions

- TypeScript strict, ESM throughout, vitest for tests, `tsc --noEmit` as the type gate. There is
  no ESLint or Prettier setup, so match the style around your change.
- Plain, direct comments that explain why.
- Use the words in [docs/brand.md](docs/brand.md) in the UI, the exports and the docs: Connect,
  Start recording, Check, Run, case, step, setup block. Sentence case, buttons are verbs, and
  errors say what happened and what to do next.
- **No em dash character** in docs, UI text, code comments or commit messages. Use a comma, a
  colon, parentheses, or reword the sentence.
- Secrets never appear in flows, case JSON, logs or screenshot filenames. A value from `.env`
  is recorded as `${KEY}`.
- No step is recorded that Maestro cannot replay. A control that has no Maestro command is
  live-only, and it is off while recording.
- Documentation pages live in `apps/docs`, with the navigation in
  `apps/docs/.vitepress/config/navigation/`. Update them in the same pull request as a change
  they describe.

## Keyboard touch positions are never logged or stored

**Use the phone** reads raw touches through `adb` (`getevent`), so it is effectively a keylogger:
a touch on the keyboard is a key press, and a list of those positions is enough to work out what
was typed, passwords included.

So this rule has no exceptions, including for debugging, a test harness or a temporary log:

- Touches are never logged or stored.
- Keyboard touches are dropped as soon as their place is known.
- Text only ever comes from the focused field, and a password field's value is never read.

A test harness once logged keyboard positions. Do not reintroduce that. A pull request that
keeps, prints or sends a touch position inside the keyboard will not be merged.

## Pull requests

Keep a pull request to one change. Before you open it, run `pnpm typecheck` and `pnpm test`, add
tests for new behaviour, and note in the template which real device you tried it on, if any.

By contributing you agree that your contribution is licensed under the [Apache-2.0](LICENSE)
licence of this project.

Maestro is a trademark of mobile.dev. Ariadne is an independent tool and is not affiliated with
mobile.dev.
