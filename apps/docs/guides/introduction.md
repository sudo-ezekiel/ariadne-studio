---
title: A no-code test recorder for Maestro
description: Ariadne is a no-code test recorder for Maestro. Business analysts record Android tests by using the app and get plain Maestro YAML.
---

# Introduction

**Ariadne, a recorder for Maestro.** A no-code test recorder: record Android tests by using your app, on your own machine.

A business analyst or product manager clicks through the app on a mirrored screen, and every click becomes a Maestro step with a stable selector and a screenshot. The output is plain Maestro YAML that `maestro test` runs on a laptop and in CI.

In Ariadne, "record" means capturing steps. If you came here looking for a video of a test, see [Run video](/guides/run-video).

## Who it is for

- **The person who knows the product.** Record cases without writing YAML, run them, and hand over a [test case document](/guides/test-case-documents) in Excel, HTML or Markdown that matches the flow exactly.
- **Developers.** Write reusable Maestro flows as [setup blocks](/guides/setup-blocks) (log in, skip onboarding) that a recording can start after, review the generated flows in pull requests, and get per-step screenshots, flaky tags and shareable reports for every run.

## The loop

1. **Connect** an emulator or a USB phone. Ariadne shows its screen and outlines the element under your pointer.
2. **Record** by using the app: tap, type, swipe, scroll, press Back. Each step gets a Maestro selector and a screenshot.
3. **Check** what must be on screen, by toggling Check and clicking it.
4. **Run** one case or all of them. Ariadne runs the flow with the Maestro CLI and keeps a screenshot after every step.
5. **Review** what ran: which steps passed, how long each took, which screens look different from the recording, and a report you can send.

![Recording a case: the phone screen on the left with an ochre frame, the recorded steps on the right](/shots/recording.png)

## What you get

- **Plain Maestro YAML.** One flow file per case, regenerated from the recorded steps on every save.
- **Selectors chosen for you.** Resource id, then visible text, escaped the way Maestro expects. See [How clicks become selectors](/reference/selectors).
- **A screenshot after every step, on every run.** Recorded and replayed screens sit side by side, and screens under 85% alike are marked "looks different" even when the step passed.
- **Flaky tests get a tag.** Run all retries a failure once and tags failed-then-passed as flaky. Every case carries its run history.
- **Cases that start where another ends.** "Submit claim" starts from the end of "Log in", and the chain is one Maestro suite.
- **Edits without re-recording everything.** Re-record from step N, add steps in the middle, split, rename, mute.
- **Test case documents.** Excel, HTML and Markdown with preconditions, steps, expected results and screenshots.
- **Your existing flows.** Any Maestro flow in `blocks/` becomes a starting point, with secrets passed as `${KEY}` from `.env`.

## The YAML it writes

```yaml
appId: com.example.claims
name: Submit a claim
---
- launchApp
- runFlow:
    file: ../blocks/login.yaml
    env:
      USERNAME: "${USERNAME}"
      PASSWORD: "${PASSWORD}"
- tapOn:
    text: "Claims"
- tapOn:
    id: "com\\.example\\.claims:id/new_claim"
- inputText: "Rear bumper, parking lot"
- hideKeyboard
- scrollUntilVisible:
    element:
      text: "Submit"
    direction: DOWN
- tapOn:
    text: "Submit"
- assertVisible:
    text: "Claim submitted"
```

There is one file per case in `flows/`, regenerated from the case on every save. Run it with `maestro test flows/<caseId>.yaml` anywhere Maestro runs.

## Built on Maestro

Maestro is the open source mobile UI testing framework by mobile.dev. Its tests are YAML Flows run by the Maestro CLI. Ariadne writes Flows for it and runs them with the Maestro CLI, and it does not replace Maestro. Everything Ariadne records is an ordinary Flow, and setup blocks are ordinary Flows you may already have.

- Maestro's documentation: [docs.maestro.dev](https://docs.maestro.dev/)
- The Flow syntax reference: [docs.maestro.dev/reference](https://docs.maestro.dev/reference)

If you already use Maestro, start with [If you know Maestro](/guides/if-you-know-maestro).

## Privacy

Ariadne runs on your machine against your own emulator or phone, and it has no account, no cloud service and no upload of its own. The Maestro CLI it runs has its own analytics setting, covered under [Privacy](/guides/if-you-know-maestro#privacy) on the Maestro page.

## Status

Ariadne is early, and it is Android only. The desktop app is on the [Releases](https://github.com/sudo-ezekiel/ariadne-studio/releases) page and the npm package is `ariadne-studio`, see [Install and set up](/guides/install).

Next: [Install and set up](/guides/install).
