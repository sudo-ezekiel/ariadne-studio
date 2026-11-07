---
title: "FAQ: Ariadne, Maestro Studio and Waldo"
description: "Frequently asked questions about Ariadne: how it relates to Maestro, Maestro Studio and Waldo, and whether you need to know YAML."
---

# General

Frequently asked questions about Ariadne.

## What is Ariadne?

A local Android test recorder for business analysts and product managers. You use your app on a mirrored screen, and Ariadne writes plain Maestro YAML, with a screenshot of every step. The app is called Ariadne Studio.

## Is this the same as `maestro record`?

No. `maestro record` renders a video of a Flow you already have. Ariadne writes the Flow, from your clicks. A [video of each run](/guides/run-video) is optional, uses the same layout, the steps beside the phone, and is made on your machine.

## Is Ariadne a replacement for Maestro?

No. Ariadne records Maestro flows and hands them to the Maestro CLI to run. What it adds is the recorder, the results view and the document export.

## How is Ariadne different from Maestro Studio?

Maestro Studio is mobile.dev's own tool for developers working on flows. Ariadne is built for the person who knows the product but does not write YAML: it records whole cases by use, keeps a screenshot and a run history for every step, lets one case start where another ends, and exports test case documents. Both produce flows the Maestro CLI runs.

## Is Ariadne a Waldo alternative?

For recording tests without writing them, yes. As with Waldo, you record a test by using the app. Ariadne runs on your own machine, against an emulator or a USB phone, and keeps each test as a plain Maestro Flow in your repository. See [how the tools compare](/guides/compare).

## Do I need to know YAML?

No. Recording, checking, running and exporting happen in the studio, and so does writing [setup blocks](/guides/setup-blocks): they are YAML files, but the **Blocks** tab writes them from a form.

## Does Ariadne need the cloud?

No. It runs on your machine against an emulator or a USB phone. Ariadne has no account and no service of its own, and nothing it records is uploaded. The Maestro CLI has its own analytics setting, see [Privacy](/guides/if-you-know-maestro#privacy).

## Does it support iOS?

Not today. Ariadne records on Android emulators and USB phones.

## Where do the tests live?

In a folder you choose: `flows/` holds the Maestro YAML, `cases/` the recorded steps, `evidence/` their screenshots, `runs/` the results of every run, `exports/` the documents. The Files sidebar in the studio shows all of it. See [Your project files](/guides/project-files).

## Can developers edit the YAML by hand?

Flows are plain files, so yes, but a case's flow is regenerated from the recorded case on the next save or run. Edit the steps of a recorded case in the studio, and put flows you want to own by hand in `blocks/`.

## Can I use my existing `.maestro` folder?

Yes. `npx ariadne-studio init` adds Ariadne beside it, your subflows become setup blocks, and recorded flows land in `.maestro/recorded`. See [Use with an existing Maestro project](/guides/existing-maestro-project).

## Can a BA and a developer share a project?

Yes. The desktop app, the npm package and the repository all read and write the same project folders.

## What is Maestro?

Maestro is a mobile UI testing framework by mobile.dev. Tests are YAML flows that the Maestro CLI runs on Android and iOS devices and emulators. See [docs.maestro.dev](https://docs.maestro.dev/).
