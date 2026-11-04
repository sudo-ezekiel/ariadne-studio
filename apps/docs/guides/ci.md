---
title: Run recorded Maestro flows in CI
description: Run recorded Ariadne cases in CI with maestro test. Ariadne itself is not needed there.
---

# CI

A recorded case is a plain Maestro flow, so your pipeline needs Maestro and a device, and no Ariadne.

## What CI needs

- The repository, with the flows folder and the block folders side by side as they are in the project. A flow reaches its blocks by relative paths such as `../blocks/login.yaml`.
- The Maestro CLI and Java.
- A running Android emulator or an attached device, with the app installed. Maestro's documentation covers [installing the CLI](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli) and [CI setups](https://docs.maestro.dev/maestro-cloud/ci-cd-integration/generic-ci-platform).

## Run the flows

From the project folder:

```sh
maestro test flows/<caseId>.yaml                          # one case
maestro test flows                                        # every case
maestro test -e USERNAME=... -e PASSWORD=... flows        # with values
```

In a project made with `init`, use the workspace path from the repository root: `maestro test .maestro/recorded`.

## Pass the values

`.env` is not in the repository, so CI passes each value with `-e KEY=VALUE`, from your CI system's secret store. Pass every key the flows use, including test users such as `SUPERVISOR_PASSWORD` and any non-secret keys from `env` in `project.json`.

The studio does this for you on a run, because it reads both files. `maestro test` reads neither. See [parameters and constants](https://docs.maestro.dev/maestro-flows/flow-control-and-logic/parameters-and-constants) in Maestro's documentation.

## Reports for CI

`maestro test` writes JUnit itself:

```sh
maestro test --format junit --output build/report.xml flows
```

See [test reports and artifacts](https://docs.maestro.dev/maestro-flows/workspace-management/test-reports-and-artifacts) in Maestro's documentation.

## What differs from Run all

Some things belong to the studio, so they do not happen under `maestro test`:

- **Screenshots after every step.** They are added to the run copy only. `flows/<caseId>.yaml` has none.
- **Retry and the flaky tag.** These are Run all's rules.
- **Muted.** Muting is a setting on the case, so a muted case's flow is still in `flows/` and `maestro test flows` runs it.
- **Order.** Run all takes parents before the cases that start from them. A chained flow runs its parent's flow in full either way, through `runFlow`, so a folder run repeats parents.
- **Run video.** The setting applies to the studio's run copy only.

## Where the files go

Ariadne writes nothing in CI. Maestro's output goes where you tell it, by default under `~/.maestro/tests`.

## Privacy

Values passed with `-e` can appear in Maestro's own logs in CI, because Ariadne's clean-up of `.env` values runs only in the studio. Treat those logs as you treat the secrets.
