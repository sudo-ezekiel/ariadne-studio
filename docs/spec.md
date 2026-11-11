# Spec: BA recorder for Maestro flows

Status: decided design for Milestones 1 to 8. Section 17 lists what comes later.
Product name: Ariadne (decided 2026-11-02). Branding, colours and the words the studio uses are in docs/brand.md; where this spec says Open/Close, Start case, Expect and Replay, the studio now says Connect/Disconnect, Start recording, Check and Run.
Owner: Ezekiel. Written 2026-10-30.

## 1. What this is

A local tool that lets a non-technical person (a business analyst or PM) record mobile
acceptance tests by using the app on a mirrored device screen. Every click goes through
agent-device, is resolved against the accessibility snapshot, and is written as a Maestro
step with a stable selector and a screenshot. Developers or coding agents author reusable
blocks (login, onboarding) as ordinary Maestro `runFlow` files. The tool replays a block to
reach a state, hands the live screen to the BA, and records the delta. Output is plain
Maestro YAML that the Maestro CLI replays locally and in CI.

Why these choices:

- The artifact is Maestro YAML because it is the de facto interchange format for mobile
  flows, free to run locally, and portable to Maestro Cloud, Momentic and agent-device.
- The recorder works on a mirror first, because agent-device records actions issued
  through it. Maestro Studio, Repeato and Waldo all used a mirror too. Touches on the
  phone itself came later (section 15).
- No test case document is required as input. Boundaries, names and expectations are
  captured during the session. The test case document is an output (Milestone 3).
- AI is used only at authoring time for cleanup (naming, selector hardening) and never
  at runtime. Replay is deterministic.

## 2. Non-goals for Milestones 1 and 2

- iOS. Android emulator and USB Android phone only. Design nothing that blocks iOS later.
- Web. Maestro and agent-device both support it; not now.
- Capturing physical touches on a phone (adb getevent). Milestone 7, section 15.
- Voice narration, record-then-split timeline, Excel or Word export. Milestone 3.
- Packaging as Electron or Tauri. The MVP is a local Node server plus a browser UI,
  launched by one command. Keep the server and UI separable so wrapping later is cheap.
- Authentication, multi-user, cloud. None.

## 3. Verified facts about the dependencies (checked 2026-10-30)

Toolchain on this machine: Node v22.22.3, pnpm 11.9.0, Java 17, adb at
`~/Android/Sdk/platform-tools/adb`, Maestro CLI 2.12.0 at
`~/.maestro/bin/maestro` (not on PATH by default; add `$HOME/.maestro/bin`). Two emulators
are booted: `emulator-5554` (API 26, Android 8.0) and `emulator-5556` (Pixel 8a image,
Android 16). Use `emulator-5556` for development and smoke tests. `com.android.settings`
is installed on both and is the smoke-test target app.

agent-device `0.21.35` (npm `agent-device`, MIT). Typed Node API, ESM:

```ts
import { createAgentDeviceClient } from 'agent-device';
const client = createAgentDeviceClient({ session: 'studio', cwd: projectDir });
await client.devices.list();                         // AgentDeviceDevice[] (id, platform, kind, booted)
await client.apps.open({ app, platform: 'android', device: 'emulator-5556', foreground: true });
const snap = await client.capture.snapshot({ interactiveOnly: false });
// snap.nodes: SnapshotNode[]  snap.viewport?: { width, height }  snap.refsGeneration
await client.capture.screenshot({ path, scale: 0.5 }); // returns { path }
await client.interactions.press({ x, y, settle: true }); // PointTarget; also { ref } or { selector }
await client.interactions.fill({ x, y, text });          // replaces field content
await client.interactions.type({ text });                // appends to focused field
await client.command.back(...);                          // see BackCommandOptions in the d.ts
await client.replay.run({ path, maestro: true, ... });   // replays Maestro YAML subset
await client.sessions.close();
```

`SnapshotNode` fields that matter here: `ref`, `role`, `text`, `label`, `contentDescription`,
`identifier` (Android resource-id), `rect` ({x,y,width,height} in viewport pixels),
`hittable`, `enabled`, `visibleToUser`, `editable`, `placeholder`, `depth`, `parentIndex`,
`systemBar` ('status' | 'navigation' when the node belongs to a system bar),
`keyboardOwned`, `interactionBlocked`. Read the d.ts at
`node_modules/agent-device/dist/src/sdk-contracts.d.ts` and `client-types.d.ts` before
coding; do not guess field names. The exact `role`, `text` and `label` semantics on
Android must be confirmed by dumping a real snapshot of the Settings app and reading it.

agent-device selector grammar (for its own `press`/`wait`): `id="..."`, `label="..."`,
`text="..."`, `role="..."`. We press by point, so we rarely need it.

Maestro facts to respect:

- A flow file has a header (`appId:` required, optional `name:`, `env:`), then `---`, then a
  list of commands.
- `tapOn` accepts `id`, `text`, `index`, `point: "x%,y%"`; `text` matches visible text and
  accessibility text (content-desc). `id` matches the Android resource-id.
- Selector strings are regular expressions. Escape `. * + ? ^ $ { } ( ) | [ ] \` in any text
  or id we emit. Verify a tap on a text containing parentheses replays correctly.
- `inputText` types into the focused field. `eraseText`, `back`, `hideKeyboard`,
  `assertVisible`, `assertNotVisible`, `launchApp`, `runFlow: { file, env }` are the
  commands we use. `runFlow.file` is relative to the flow that contains it.
- `maestro test <flow.yaml> --debug-output <dir> -e KEY=VALUE` writes
  `commands-(<flow name>).json` with per-command status, a `maestro.log`, and a screenshot
  on failure. Confirm the exact file names by running it once; do not hardcode from memory.
- Maestro CLI startup is several seconds. Never call it per step; only for Replay.

## 4. Repository layout

pnpm workspace, TypeScript strict, ESM throughout, vitest for tests, `tsc --noEmit` as the
type gate. No ESLint or Prettier setup in this milestone; match the existing style.

```
package.json                 # workspace root: scripts dev, build, test, typecheck, smoke
pnpm-workspace.yaml
tsconfig.base.json
docs/spec.md                 # this file
packages/core/               # @e2e-tool/core: no UI, no HTTP, testable in isolation
  src/
    device/session.ts        # DeviceSession wrapper over agent-device
    device/hit-test.ts       # resolveNodeAt(nodes, point) -> SnapshotNode | undefined
    maestro/selector.ts      # chooseSelector(node, allNodes) -> MaestroSelector
    maestro/model.ts         # MaestroFlow, MaestroStep types
    maestro/emit.ts          # toMaestroYaml(flow) -> string
    maestro/escape.ts        # escapeMaestroRegex
    maestro/parse.ts         # parseMaestroFlow(yaml) -> MaestroFlow
    recorder/case-types.ts   # TestCase, CaseStep, Expectation (type only)
    recorder/recorder.ts     # in-memory case being recorded; caseToFlow
    recorder/flow-layout.ts  # caseFlowItems, scrollTargets: flow order (pure)
    recorder/expectations.ts # expectationCandidates for the picker (pure)
    recorder/recorded-node.ts # node details kept in case files (pure)
    recorder/describe.ts     # step and flow item descriptions (pure, UI)   (Milestone 3)
    replay/maestro-bin.ts    # findMaestro, androidHome
    replay/maestro-run.ts    # runMaestro, readMaestroCommands        (Milestone 2)
    replay/run-result.ts     # parseMaestroRun, correlateRun, summarizeRun (pure)
    replay/instrument.ts     # instrumentForRun: screenshot after each command (Milestone 4)
    replay/device-replay.ts  # replaySegments: what agent-device replays, what the studio does (Milestone 6)
    replay/suite.ts          # Run all order and outcome, case health (pure, UI)
    image/png.ts             # decodePng, encodePng, resizeImage (node:zlib)
    image/similarity.ts      # screenSimilarity, LOOKS_DIFFERENT_BELOW (pure)
    export/document.ts       # caseDocument, caseMarkdown, casesSheets (pure)  (Milestone 3)
    export/html.ts           # casesHtml, runReportHtml, suiteReportHtml (pure)
    export/report.ts         # runReportRows (pure)
    export/xlsx.ts, zip.ts   # buildXlsx over a minimal zip writer
    project/store.ts         # ProjectStore: project.json, cases, flows, evidence, runs, suites
    types.ts                 # type-only entry for browser code
    index.ts
  test/                      # vitest unit tests; test/fixtures/ holds real commands.json files
apps/studio/                 # @e2e-tool/studio: Fastify server + Vite React UI
  src/server/                # index.ts (buildServer, startStudio), main.ts (dev entry), routes.ts (device and recording), cases.ts
                             # (saved case edits), replay.ts (Replay, Run all, reports),
                             # exports.ts (documents), common.ts, state.ts
  src/shared/api-types.ts    # request and response shapes shared by server and UI
  src/ui/                    # main.tsx, App.tsx, api.ts, styles.css, components/:
                             #   TopBar, Mirror, CasePanel, SavedCases, CaseDetail,
                             #   ExpectationPicker, Toasts, format.ts
  index.html, vite.config.ts
apps/cli/                    # ariadne-studio on npm: CLI entry; build.ts bundles CLI, server and UI into dist/
apps/desktop/                # Electron app: main process runs apps/cli/dist/cli.mjs as a child (see apps/docs/contribute/packaging.md)
scripts/smoke.ts             # end-to-end proof against emulator-5556 + Settings app
scripts/smoke-studio.ts      # Milestones 3 and 4 through the server API on a real device
scripts/smoke-gestures.ts    # Milestone 6 through the server API on a real device
workspace/                   # default dev project directory (see section 5); gitignored
                             # except workspace/blocks/*.yaml and workspace/project.json
```

Package names: `@e2e-tool/core`, `@e2e-tool/studio`. These are working names; renaming
later is fine.

## 5. Project directory (the BA's test project)

The server takes a project directory as its only argument (default `./workspace`). Layout:

```
project.json        # { appId, platform: "android", lastDeviceId?, env?: Record<string,string> }
.env                # secrets for replay, KEY=VALUE, gitignored, passed to maestro as -e flags
blocks/             # reusable Maestro sub-flows written by developers or agents, e.g. login.yaml
flows/<caseId>.yaml # one Maestro flow per recorded case
cases/<caseId>.json # case metadata, see below
evidence/<caseId>/  # step-NNN.png screenshots taken after each recorded action
runs/<runId>/       # Maestro debug output plus summary.json             (Milestone 2)
```

`caseId` is a slug of the case name plus a short timestamp suffix, filesystem safe.

`cases/<caseId>.json`:

```json
{
  "id": "submit-claim-20261030-1712",
  "name": "Submit claim with expired policy",
  "appId": "com.example.app",
  "createdAt": "2026-10-30T17:12:00Z",
  "deviceId": "emulator-5556",
  "preconditionBlocks": ["blocks/login.yaml"],
  "steps": [
    {
      "index": 1,
      "kind": "tap",
      "selector": { "kind": "id", "value": "com.example:id/claims" },
      "node": { "text": "Claims", "identifier": "com.example:id/claims", "rect": { "x": 0, "y": 0, "width": 0, "height": 0 } },
      "screenshot": "evidence/submit-claim-20261030-1712/step-001.png",
      "at": "2026-10-30T17:12:05Z"
    }
  ],
  "expectations": []
}
```

The JSON is the source of truth for the UI. The YAML in `flows/` is regenerated from it on
every save, so a BA never edits YAML and a developer can still read and commit it.

## 6. Core behaviour

### 6.1 DeviceSession (`packages/core/src/device/session.ts`)

Thin wrapper over one agent-device client. Responsibilities:

- `listDevices()`: booted Android devices only, for the picker.
- `open({ deviceId, appId })`: `apps.open` with `platform: 'android'`, `device: deviceId`,
  `foreground: true`. Store `viewport` from the first snapshot.
- `capture()`: take a snapshot (`interactiveOnly: false`) then a screenshot to a given path
  with `scale: 0.5` (configurable). Return `{ nodes, viewport, screenshotPath, takenAt }`.
  Snapshot first, then screenshot, so the two describe the same screen as closely as possible.
- `tapAt(point)`: `interactions.press({ x, y, settle: true })`. Point is in viewport pixels.
- `typeText(text)`: `interactions.type({ text })`.
- `back()`: the back command.
- `close()`.

No recording logic here. No HTTP here. Every method is async and surfaces agent-device
errors unchanged (normalize with `normalizeAgentDeviceError` for the message only).

### 6.2 Hit testing (`device/hit-test.ts`)

`resolveNodeAt(nodes, point)`:

1. Candidates: nodes with a `rect` containing the point, `visibleToUser !== false`,
   `systemBar` undefined, `interactionBlocked` undefined.
2. Prefer candidates that are `hittable` or have `identifier`, `text`, `label` or
   `contentDescription`.
3. Among those, pick the smallest area; tie-break by greater `depth`.
4. If nothing qualifies, return `undefined` and the caller records a `point` tap.

Pure function. Unit tested with hand-built node arrays, including nested containers,
overlapping siblings, and a system navigation bar node covering the bottom.

### 6.3 Selector choice (`maestro/selector.ts`)

`chooseSelector(node, allNodes, point, viewport)` returns one of:

```ts
{ kind: 'id', value: string, index?: number }
{ kind: 'text', value: string, index?: number }
{ kind: 'point', xPercent: number, yPercent: number }
```

Order of preference:

1. `identifier` if present and non-empty. Emit the full resource-id as given by the
   snapshot. If other nodes on screen share the same identifier, add `index` equal to the
   node's position among them in document order.
2. Visible `text`, then `contentDescription`, then `label`, whichever is first non-empty,
   trimmed, and under 80 characters. Same uniqueness rule with `index`.
3. Otherwise `point` with percentages of the viewport, rounded to integers.

Emit `text` and `id` through `escapeMaestroRegex`. Unit test: duplicates get an index,
regex metacharacters are escaped, long texts fall back, missing rect falls back to point.

### 6.4 Maestro model and emitter (`maestro/model.ts`, `maestro/emit.ts`)

```ts
type MaestroStep =
  | { kind: 'launchApp'; clearState?: boolean }
  | { kind: 'runFlow'; file: string; env?: Record<string, string> }
  | { kind: 'tapOn'; selector: MaestroSelector }
  | { kind: 'inputText'; text: string }
  | { kind: 'eraseText'; chars?: number }
  | { kind: 'back' }
  | { kind: 'hideKeyboard' }
  | { kind: 'assertVisible'; selector: MaestroSelector }
  | { kind: 'assertNotVisible'; selector: MaestroSelector };

type MaestroFlow = { appId: string; name?: string; env?: Record<string,string>; steps: MaestroStep[] };
```

`toMaestroYaml(flow)` builds a plain object and serialises with the `yaml` npm package.
Output must be exactly what Maestro accepts:

```yaml
appId: com.android.settings
name: Open network settings
---
- launchApp
- tapOn:
    text: "Network & internet"
- assertVisible:
    text: "Wi-Fi"
```

`point` selectors emit `point: "50%,30%"`. `index` emits as a sibling key of `id` or
`text`. Unit test the emitter against these literal strings. Also write a tiny parser,
`parseMaestroFlow(yamlText)`, that reads the header and the step list back into
`MaestroFlow` for the commands above and throws on anything else; it is used by the UI to
show existing flows and blocks. Round-trip test: emit then parse equals the input.

### 6.5 Recorder (`recorder/recorder.ts`)

In-memory state for one case: name, appId, deviceId, `preconditionBlocks`, `steps[]`,
`expectations[]`. Methods: `start(meta)`, `recordTap(node | undefined, point, viewport,
screenshotPath)`, `recordInput(text)`, `recordBack()`, `recordExpectation(node)`
(Milestone 2), `toCase()`, `toFlow()`. `toFlow()` produces: `launchApp` first (with
`clearState: true` only when a precondition block is present, otherwise plain
`launchApp`), then one `runFlow` per precondition block with the project `env` keys passed
through as `${KEY}`, then the recorded steps, then the expectations as `assertVisible`.

Typing: consecutive `recordInput` calls into the same focused field merge into one
`inputText` step. A tap after typing ends the merge.

### 6.6 ProjectStore (`project/store.ts`)

Create the directory layout if missing. Read and write `project.json`, list cases, save a
case (JSON plus regenerated YAML), list blocks (`blocks/*.yaml`, parsed with
`parseMaestroFlow`, name from header or filename), allocate evidence paths, read `.env`
into a `Record<string,string>` (simple KEY=VALUE parser, no interpolation).

## 7. Studio server (`apps/studio/src/server`)

Fastify 5, ESM, one process, one DeviceSession at a time. Serves the built UI from
`apps/studio/dist/ui` in production; in dev, Vite runs separately and proxies `/api`.

State: `{ project: ProjectStore, session?: DeviceSession, recorder?: Recorder,
latest?: { nodes, viewport, screenshotPath, takenAt } }`. Every action handler ends by
calling `session.capture()` into the case's evidence directory (or a scratch directory
when no case is active) and returning the new `ScreenState` to the client.

```
GET  /api/project                      -> { appId, platform, lastDeviceId, blocks: [...], cases: [...] }
PUT  /api/project                      <- { appId }                 (Milestone 1: appId only)
GET  /api/devices                      -> [{ id, name, platform, kind, booted }]
POST /api/session/open                 <- { deviceId, appId } -> ScreenState
POST /api/session/close
GET  /api/screen                       -> ScreenState (latest, no new capture)
GET  /api/screen/image?ts=...          -> PNG of the latest screenshot
POST /api/action/tap                   <- { x, y } viewport pixels -> { step?, screen }
POST /api/action/type                  <- { text }                -> { step?, screen }
POST /api/action/back                                             -> { step?, screen }
POST /api/case/start                   <- { name }                -> { caseId }
POST /api/case/finish                                             -> { caseId, flowPath, yaml }
POST /api/case/discard
GET  /api/case/current                 -> Case | null  (steps with selectors and screenshot URLs)
GET  /api/evidence/:caseId/:file       -> PNG
```

`ScreenState = { width, height, imageUrl, takenAt, nodes: SnapshotNodeLite[] }` where
`SnapshotNodeLite` keeps `ref, role, text, label, contentDescription, identifier, rect,
hittable, systemBar` and nothing else; the UI uses rects only to draw the highlight of the
resolved node after a tap and to show a hover outline.

Tap handler order: resolve node against `latest.nodes`; press at the node's rect centre if
a node was resolved, else at the raw point; if a recorder is active, `recordTap`; capture;
respond. If `latest` is older than 5 seconds, re-snapshot before resolving.

Errors: return `{ error: { code, message } }` with 4xx for client mistakes (no session, no
case) and 5xx for device failures, with the agent-device message passed through. Log every
action with timing to stdout; nothing fancier.

## 8. Studio UI (`apps/studio/src/ui`)

React 19, Vite, TypeScript, plain CSS in one file. No component library, no state library.
Functional and legible beats pretty. Layout:

- Top bar: device select (booted devices), appId text input (prefilled from project),
  Open and Close buttons, connection status.
- Left: the mirror. An `<img>` of the latest screenshot scaled to fit the available height,
  preserving aspect ratio. Click converts to viewport pixels using the `ScreenState`
  width and height and POSTs `/api/action/tap`. After the response, draw the resolved node
  rect as an outline for about a second. Hover draws the outline of the node under the
  cursor using the lite nodes (pure client-side hit test, same rules as the server; share
  the function from core if the bundling is simple, otherwise copy it and note that).
  Below the mirror: a text field plus a Type button (POSTs `/api/action/type`), and a Back
  button. Since 2026-11-11 the mirror also draws a real `<input>` over the node that is
  `focused` and `editable` (or `password`, then `type="password"`), in plain tap mode only.
  `toLiteNode` passes those three flags, never a value. It takes focus only after a tap on the
  mirror; Enter or Tab sends it through the same Type call, Escape clears it, and a mirror
  click with text pending sends the text before the click. The text field below stays for
  fields the snapshot does not report.
- Right: case panel. When no case is active: a name field and Start case. When active: the
  case name, the live step list (one row per step: index, kind, selector shown as
  `id: ...` or `text: ...` or `point`, thumbnail of the step screenshot), Finish case and
  Discard buttons. Finish shows the resulting YAML in a read-only block with the file path.
- A toast area for errors.

The UI is polled, not pushed: after every action the response carries the new screen. No
WebSocket in Milestone 1.

## 9. Milestone 1: definition of done

1. `pnpm install && pnpm typecheck && pnpm test` pass from the repo root.
2. `pnpm dev` starts the server on a fixed port (default 4711) and the Vite UI; opening
   the UI in a browser, picking `emulator-5556`, entering `com.android.settings`, and
   clicking Open shows the Settings screen in the mirror within a few seconds.
3. Clicking a Settings entry in the mirror navigates on the emulator, the mirror updates,
   and a step appears in the case panel with an `id` or `text` selector, not a point.
4. Start case, perform three taps and one Back, Finish case: `workspace/flows/<id>.yaml`,
   `workspace/cases/<id>.json` and four screenshots under `workspace/evidence/<id>/` exist.
5. `scripts/smoke.ts` (run with `pnpm smoke`) does steps 2 to 4 headlessly through
   `@e2e-tool/core` with no browser, then runs
   `maestro test workspace/flows/<id>.yaml` and exits non-zero if Maestro fails. This is
   the proof that recorded selectors replay. Run it and paste the Maestro output in the
   report.
6. README at the repo root: prerequisites, how to run, how to add a block, where files go.

If Maestro cannot replay a recorded selector (for example the Android `identifier` from
agent-device is not what Maestro's `id` expects), fix the selector mapping until the smoke
test passes, and document what the mapping is. That mapping is the most important thing
in this milestone.

## 10. Milestone 2 (after Milestone 1 is reviewed)

- Blocks: list `blocks/*.yaml` in the case panel; before Start case the BA can tick blocks
  to run as preconditions. Start case then replays each block with
  `client.replay.run({ path, backend: 'maestro', env: ['KEY=VALUE', ...], serial,
  platform: 'android', testIme: false })` through the studio's own client, in order, and
  only then hands the mirror over. The client must be created with an explicit
  `stateDir` (agent-device's default): without one, agent-device sends `replay` to a
  private one-shot daemon that cannot use the device the studio session holds. The
  blocks are recorded in `preconditionBlocks` and emitted as `runFlow`. Ship one example
  `blocks/open-settings.yaml` for the smoke test, and document the login block pattern
  with `${USERNAME}` and `${PASSWORD}` from `.env`.
- launchApp (supersedes the rule in 6.5): a case's flow always starts with a plain
  `launchApp`, never `clearState`, with or without blocks. Clearing state is the block
  author's decision (a login block starts with `launchApp: { clearState: true }`), so
  recording and replay both run the block and see the same state.
- Expect mode: a toggle; while on, clicking a node records an inline `expect` step at
  that position in the case (emitted as `assertVisible` in step order) with the same
  selector rules instead of tapping, and does not touch the device. A click that would
  need a `point` selector is refused. `POST /api/case/expect <- { x, y }`.
- Scroll: two buttons, Scroll down and Scroll up, record a `scroll` step. Nothing else is
  recorded as a gesture. `POST /api/action/scroll <- { direction: 'down' | 'up' }`. A
  scroll whose next step, skipping further scrolls in the same direction, is a tap or
  expect with an `id` or `text` selector (or, at the end of the case, the first end
  expectation) is emitted as `scrollUntilVisible` on that selector, `direction: DOWN` for
  down and `UP` for up. Maestro waits for and scrolls to the element, so replay depends
  neither on scroll distance nor on the screen being drawn. Each step stays one Maestro
  command: in a run of scrolls each gets the same target, and the later ones complete at
  once. Any other scroll is emitted as `scroll` (down) or `swipe: { direction: DOWN }`
  (up); a plain `scroll` straight after `launchApp` can run before the screen is drawn.
- Typing: text equal to a project env value is recorded as its `${KEY}` and never merges
  with other typing; in a password field, any other text is refused.
- Finish case shows an expectation picker: visible text nodes from the final snapshot,
  excluding system bars, excluding values that look volatile (numbers, dates, times,
  currency amounts, percentages, strings under 3 characters), ranked by position from the
  top and by rect height. The BA ticks one to three; they are appended as `assertVisible`
  after the steps. API: `GET /api/case/candidates -> { candidates: [{ id, selector,
  node, label }] }` (at most 12, only unique `id` or `text` selectors), then
  `POST /api/case/finish <- { picks?: number[] }` with candidate ids, computed again from
  the same snapshot.
- Replay: a Replay button per saved case runs
  `maestro test flows/<id>.yaml --debug-output runs/<runId> -e KEY=VALUE...` from `.env`,
  parses the commands JSON into per-step pass or fail, shows the result beside the recorded
  steps, and shows Maestro's failure screenshot when there is one.
  The studio closes its agent-device session for the run and reopens it afterwards
  without a relaunch. `POST /api/cases/:caseId/replay -> RunSummary`, written to
  `runs/<runId>/summary.json` with `runId = <caseId>-<yyyymmdd-hhmmss>`.
- Cases list: reopen a saved case read-only, delete a case.
  `GET /api/cases/:caseId -> { case, yaml, runs }`, `DELETE /api/cases/:caseId`.

## 11. Milestone 3: edit and chain (Waldo's test builder)

Decided 2026-10-31. Waldo (Tricentis since 2023, recorder retired) is the closest prior art
for a BA recording in a mirror. These are the parts of its test builder that fit a local tool
whose output is Maestro YAML:

- Start from a saved case (Waldo's test dependencies). Start case takes either ticked
  blocks or one saved case, never both. With a saved case the studio relaunches the app,
  writes the flows of that case and every case it starts from, replays
  `flows/<parent>.yaml` through agent-device (it supports nested `runFlow`), and records
  from where it ends. The case stores `startFrom: <caseId>`; its flow begins with
  `runFlow: { file: <parent>.yaml, env }` instead of `launchApp` plus blocks, because the
  parent flow already launches the app and runs its own blocks. A change to the parent
  reaches every child on its next run. A case that others start from cannot be deleted
  (409 `HAS_DEPENDENTS`), and the saved cases list is a tree by `startFrom`.
- Step titles and notes: every step has a generated description ("Tap "System"", "Check
  that "Internet" is visible"), which the BA can replace with a `title` and add a `note`
  (the expected result, in the BA's words). Both go into the exported documents. The
  description lives in `recorder/describe.ts`, pure, shared with the UI.
- Edit a saved case: rename, delete a step, delete an end expectation, duplicate (new id,
  evidence copied). Every edit sets `editedAt`; runs that started before it are shown as
  stale and do not count for the case's status.
- Re-record from step N ("update a test starting from a specific step"): the studio writes
  the flow of steps 1 to N-1 (with the case's blocks or start case, without end
  expectations) to `runs/_partial/<caseId>.yaml` (until Milestone 5, `flows/.studio-partial-<caseId>.yaml`), replays it through agent-device,
  deletes it, and opens the recorder on that screen with steps 1 to N-1 kept. Finish
  replaces steps N onwards and the end expectations; the picker pre-ticks old
  expectations that are still candidates. Discard restores the case as it was.
- Insert steps after step N: same replay of steps 1 to N, then the new steps go between N
  and the old step N+1, and the old end expectations are kept. Finish skips the picker.
- Split at step N (Waldo's "splitting your test"): steps 1 to N become a new case
  "<name>, start" with the original blocks or start case and no end expectations; the
  original keeps steps N+1 onwards and its expectations and now starts from the new
  case. Screenshots of the moved steps are copied to the new case's evidence directory.
- Evidence numbering: screenshot files are numbered by a per-case counter that never
  reuses a number, so deleted or replaced steps never collide with new ones. The case file
  keeps the highest number used as `lastEvidenceNumber`. For a new case the numbers still
  equal the step indexes.
- More interactions, each one step and one Maestro command: Relaunch app (`launchApp`,
  agent-device `apps.open` with `relaunch`), Open link (`openLink: <url>`; recording
  sends the same VIEW intent through `adb shell am start -W -a android.intent.action.VIEW`
  with the link single-quoted, because agent-device only opens links inside the session's
  app), Hide keyboard (`hideKeyboard`, agent-device `command.keyboard({ action: 'dismiss' })`),
  Wait (`extendedWaitUntil` on a label never on screen, `optional`, so it runs out without
  failing; a replay through agent-device simply waits, and recording does nothing on the device).
- Test case documents (the output a no-QA company actually asks a BA for): per case and
  for the whole project, as Markdown (`exports/<caseId>.md`, screenshots linked), as a
  self-contained HTML page (screenshots inlined, printable to PDF, opens in Word), and as
  an Excel workbook (`exports/<caseId>.xlsx`, or `exports/test-cases.xlsx` for the whole
  project; one row per step: case, step, action, expected result, screenshot path, plus a
  sheet of cases with their last result). The `.xlsx`
  writer is a small Office Open XML zip built with `node:zlib`, no dependency.

Left out of Milestone 3 on purpose: AI cleanup (needs an API key and a cost decision from
the owner), voice narration, iOS (needs macOS; this machine is Linux), and an Electron or
Tauri shell. Waldo's screen-similarity replay engine is also left out: replay stays
deterministic Maestro selectors, and similarity is only reported (Milestone 4).

## 12. Milestone 4: results and suite runs (Waldo's Results Studio and run rules)

- Screenshot timeline: every replay runs an instrumented copy of the case flow,
  `runs/<runId>/flow.yaml`, with `takeScreenshot: { path: after-NNN, optional: true }`
  after each command and `runFlow` paths rewritten relative to the run directory. Maestro
  writes them to `runs/<runId>/<flow name>/takeScreenshot/after-NNN.png`. The run parser
  drops those commands and attaches each file to the step before it, so results still line
  up one to one with `caseFlowItems`. `flows/<caseId>.yaml` stays clean for developers and CI.
- Looks different (Waldo's "identify discrepancies"): for each step with both a recorded
  and a replayed screenshot, the studio computes a similarity percentage on a coarse
  luminance grid with the status and navigation bars cropped, and flags steps under the
  threshold as "looks different". It never fails a run: Maestro decides pass or fail. A
  dependency-free PNG decoder and encoder live in `packages/core/src/image/`.
- Run all: one button runs every case that is not muted, one at a time, in tree order,
  as a background job (`POST /api/suite/run`, then `GET /api/suite/current` to poll).
  While it runs, every request that would touch the device gets 409 `SUITE_RUNNING`.
  With "retry failures" on (the default), a failed case runs once more; failed then passed
  is reported as flaky. Results go to `runs/_suites/<suiteId>.json`.
- Mute: a muted case is skipped by Run all and marked in the list.
- History and flakiness: the cases list shows the last ten runs of each case as dots and
  marks a case flaky when its runs since the last edit both passed and failed.
- Shareable reports: `GET /api/runs/:runId/report` writes and returns
  `runs/<runId>/report.html`, self-contained, with recorded and replayed screenshots side by
  side (replay screenshots downscaled to the recording's size) and the error text, for the
  BA to send to a developer. `GET /api/suites/:suiteId/report` is the same for a suite run,
  with failure screenshots only.

### API added in Milestones 3 and 4

```
POST   /api/case/start                 <- { name, blocks? | startFrom? }
POST   /api/action/relaunch | /api/action/hide-keyboard | /api/action/open-link <- { url }
GET    /api/case/candidates            -> { candidates, preselected? }   (re-record pre-ticks)
POST   /api/case/discard               -> { ok, restored? }               (edit: case untouched)
GET    /api/cases/:caseId              -> { case, yaml, runs, health, parent?, dependents }
PATCH  /api/cases/:caseId              <- { name?, muted? }
PATCH  /api/cases/:caseId/steps/:n     <- { title?, note? }
DELETE /api/cases/:caseId/steps/:n | /api/cases/:caseId/expectations/:n
POST   /api/cases/:caseId/split        <- { atStep, name? }
POST   /api/cases/:caseId/duplicate    <- { name? }
POST   /api/cases/:caseId/edit         <- { mode: 'rerecord', step } | { mode: 'insert', after }
DELETE /api/cases/:caseId              409 HAS_DEPENDENTS when cases start from it
GET    /api/runs/:runId | /shots/:name | /screenshot | /report
POST   /api/suite/run <- { retryFailed? } (202) ; POST /api/suite/stop ; GET /api/suite/current
GET    /api/suites ; GET /api/suites/:suiteId/report
GET    /api/cases/:caseId/export?format=md|html|xlsx ; GET /api/export?format=md|html|xlsx
```

While Run all runs, every non-GET request except `/api/suite/stop` gets 409
`SUITE_RUNNING`. `ARIADNE_SESSION_NAME` sets the agent-device session name, so two studios on
one machine do not share a session.

## 13. Milestone 5: existing Maestro projects

Decided 2026-11-03. A developer whose app repository already has Maestro tests (a
`.maestro/` folder with subflows such as `.maestro/subflows/login.yaml`, maybe a
`config.yaml`) can add Ariadne beside them without copying anything.

- Paths: `project.json` takes an optional `paths: { blocks?: string[], flows?: string }`,
  both relative to the project directory. `blocks` lists folders whose `*.yaml` and
  `*.yml` files (directly inside) are blocks; `flows` is where `<caseId>.yaml` is
  written. Absent means `blocks/` and `flows/` in the project, as before. `cases/`,
  `evidence/`, `runs/`, `exports/` and `.env` always stay in the project directory.
  `ProjectStore` reads `paths` when it opens (`resolveProjectPaths`), and creates only
  the folders inside the project.
- Block ids stay project-relative POSIX paths, so `../.maestro/subflows/login.yaml` is a
  block id. `ProjectStore.blockPath` refuses a path outside both the project directory
  and the block folders; the routes accept only blocks that `listBlocks` lists.
- Emission: `caseToFlow(testCase, envKeys, paths)` takes a `FlowPaths` (the store) whose
  `runFlowFile` gives the path from the flows folder to the block. The run copy
  (`runs/<runId>/flow.yaml`) and the partial flow rewrite runFlow paths with
  `relocateFlow` and `ProjectStore.flowsDirFrom`.
- The studio writes only `<caseId>.yaml` into the flows folder (no temp file; the write is
  not atomic there for that reason) and deletes only those of cases it owns. The partial
  flow moved to `runs/_partial/<caseId>.yaml` for every project, so `maestro test` on the
  flows folder never picks it up.
- Lenient blocks: `parseBlockFlow` (`maestro/block-parse.ts`) reads a block with the
  strict `parseStep` per command and records commands it cannot read (and header keys
  other than `appId`, `name`, `env`) by name instead of throwing. The case-flow parser
  stays strict. Only text that is not a Maestro flow (invalid YAML, no header and
  command list, no `appId`, a command that is not one string or one-key mapping) is an
  `error`. `listBlocks` follows `runFlow` files (relative to the block, up to 8 deep,
  loops ignored) and gives each block `runsWith: 'agent-device'` when everything is in
  the subset and agent-device's replay runs every command (`agentDeviceReplays`: no
  `setOrientation`, `pressKey` only Home, Back and Enter, `longPressOn` and `doubleTapOn`
  not at a point), else `'maestro'`; a runFlow whose path holds a variable needs
  Maestro, a missing runFlow file is an error.
- agent-device and nested runFlow: checked on emulator-5560 with agent-device 0.21.35:
  `replay.run` of a block whose runFlow runs another file (with `env`) replays both, so
  nested runFlow alone does not need Maestro. The same check showed agent-device
  reporting success for `runScript` and `waitForAnimationToEnd` blocks, so success from
  agent-device is not evidence that it ran a command; the choice is made from the file.
- Running with Maestro: decided statically (`replayNeedsMaestro`). When a block under
  Before recording, a block run mid-recording, a block in the replayed part of a
  re-record or insert, or any block in the start-from chain needs Maestro, the studio
  writes the same flow the case emits for that part (`launchApp` and the runFlows with
  env; for a mid-recording block only its runFlow) to `runs/_partial/<caseId>.yaml`,
  closes the agent-device session, runs `maestro test` with the `.env` values, and
  reopens the session without a relaunch, as Run does (`runPrefixWithMaestro` in
  `replay.ts`). The debug output goes to `runs/_partial/<caseId>-maestro/`, is redacted,
  and is deleted when the run passes. A failure is a 502 `MAESTRO_PREFIX_FAILED`:
  `The block "<name>" (<file>) failed in Maestro: <Maestro's message>`.
- API: `GET /api/project` adds `paths: { blocks, flows }` (absolute) and, per block,
  `runsWith` and `maestroOnly`; a Maestro block's `steps` include
  `<command> (runs in Maestro)`. The UI tags such blocks "Runs with Maestro, slower
  start" and the footer says where flows go.
- `ariadne-studio init [folder]` creates `<folder>/.ariadne/` with `project.json`,
  `cases/` and a `.gitignore` (`.env`, `evidence/`, `runs/`, `exports/`). It finds the
  workspace (`.maestro/`, else the folder or a direct subfolder with a `config.yaml`
  holding Maestro keys), takes the `appId` most flow headers use, sets `paths.flows` to
  `<workspace>/recorded` (created) and `paths.blocks` to its `subflows`, `shared`,
  `common`, `helpers` and `utils` folders (any case), prints what it created and the next
  command, and refuses an existing `.ariadne/project.json`. The studio writes the same
  `.gitignore` into any project folder it creates, when there is none.
- `.ariadne/` detection: the CLI with no folder uses `./.ariadne` when the current folder
  is not a project and `.ariadne/project.json` exists; a named folder follows the same
  rule, and so does the desktop app's Open project folder.

## 14. Milestone 6: gestures and phone buttons

Decided and built 2026-11-03, so a BA can use the whole phone from the mirror. Every
command below was first run with Maestro 2.12 on an Android 16 emulator; the emitter
writes what ran.

- Gestures on the screen, told apart by a pure classifier (`ui/components/gestures.ts`):
  a click is a tap; a press held 600 ms or more with under 8 px of movement is a long
  press; a press that moved 8 px or more is a drag. A long press resolves its element
  and selector exactly like a tap and is a `longPress` step, emitted as
  `longPressOn: <selector>`; the device holds it 3 s, Maestro's own hold. A drag is a
  `swipe` step with `from` and `to` in whole percentages of the screen and the drag's
  duration clamped to 100 to 2000 ms, emitted as
  `swipe: { start: "x%, y%", end: "x%, y%", duration: <ms> }`; the device gets the same
  rounded points, through agent-device `pan` (its `swipe` is a fixed 100 ms fling with no
  duration). The drag is drawn as an ochre line. A drag from the top edge is an ordinary
  swipe, so pulling down the notification shade records like any other.
- Right-click opens a menu at the pointer: Tap, Double tap, Long press and, while
  recording, Check that it is visible. Double tap is a `doubleTap` step, emitted as
  `doubleTapOn: <selector>`. The browser menu never shows over the screen. The mouse
  wheel does nothing. Check mode keeps priority: a click records a check, holds and drags
  do nothing.
- A row of phone buttons under the caption, shaped like a navigation bar: Back (moved
  from the toolbar, still `back`), Home, Recent apps, Volume down, Volume up, Power,
  Rotate, Enter, Zoom in, Zoom out. Home, the volume keys, Power and Enter are
  `pressKey` steps (`key: 'home' | 'volumeUp' | 'volumeDown' | 'power' | 'enter'`),
  emitted as `pressKey: Home | Volume Up | Volume Down | Power | Enter`. Power, not
  `Lock`: on Android `Lock` did nothing, `Power` turns the screen off and on like the
  phone's button. Rotate toggles portrait and landscape from the current screen shape
  and is an `orientation` step (`value: 'portrait' | 'landscape'`), emitted as
  `setOrientation: PORTRAIT | LANDSCAPE_LEFT` (agent-device's `landscape-left` and
  Maestro's `LANDSCAPE_LEFT` both set `user_rotation` 1). The mirror takes the new
  aspect ratio from the snapshot.
- Live-only controls: Maestro 2.12's key list (`maestro.KeyCode`) has no Recent apps
  key, and Maestro has no pinch command. Recent apps (agent-device `appSwitcher`) and
  Zoom in and out (agent-device `pinch`, scale 1.5 and 0.67 around the centre) work
  while connected and not recording; while recording the buttons are off with the title
  "Off while recording: Maestro cannot replay this", and the server answers 409
  `LIVE_ONLY`. No step is ever recorded that Maestro cannot replay.
- Everything that knows step kinds knows the new ones: case types, recorder, Maestro
  model, emitter and strict parser (`longPressOn`, `doubleTapOn`, `swipe` with start
  and end, `pressKey`, `setOrientation`), descriptions ("Long press "Wi-Fi"", "Swipe
  left", "Swipe down from the top edge", "Press Volume up", "Rotate to landscape"; a
  swipe gets a direction word when one axis moves at least twice as far as the other),
  kind chips, documents and run results. A scroll before a long press or double tap
  scrolls until its element is visible, as before a tap. Maestro reports the new
  commands as `tapOnElement` (with `longPress: true`, or `repeat: 2`), `swipeCommand`,
  `pressKeyCommand` and `setOrientationCommand`, one top-level command per step, so run
  results line up by position as before.
- Partial replays (re-record from step N, insert steps, start from a saved case) go
  through agent-device's Maestro backend, which 0.21.35 limits: no `setOrientation`,
  `pressKey` only for Back, Enter and Home, and `longPressOn` or `doubleTapOn` points
  only in pixels. `replaySegments` splits the flow into runs agent-device replays and
  single steps the studio does through `DeviceSession` in between. A start-from chain
  containing such a step is written out in place of its `runFlow`.

```
POST /api/action/long-press | /api/action/double-tap  <- { x, y }       viewport pixels, like tap
POST /api/action/swipe   <- { from: { x, y }, to: { x, y }, durationMs } viewport pixels
POST /api/action/key     <- { key: 'home' | 'volumeUp' | 'volumeDown' | 'power' | 'enter' | 'appSwitch' }
POST /api/action/rotate  <- { orientation: 'portrait' | 'landscape' }
POST /api/action/pinch   <- { zoom: 'in' | 'out' }                       never recorded
```

`pnpm smoke:gestures` records and runs such a case on Settings (CONTRIBUTING.md, Smoke tests).

## 15. Milestone 7: recording from the phone

Built 2026-11-04 and tested on a POCO F5 Pro (HyperOS 3, Android 15) with real fingers: a
case recorded through the studio, launchApp included, ran 17 of 17 steps with Maestro, with
no end checks. The same day a longer case stopped at a calculated value (below).

The mirror resolves a click before it presses. A finger has already pressed by the time
the studio hears of it, so while **Use the phone** is on the studio snapshots the screen
constantly and reads each touch against the last snapshot finished before it.

- `device/touch.ts` (pure): finds the touchscreen in `getevent -pl`, scales raw
  coordinates through the display rotation, turns `getevent -lt` lines into gestures.
  A slot keeps its position between touches, because the kernel does not resend one that
  has not changed, so a second tap on a spot reports no position at all.
- `device/phone-input.ts`: the adb calls. `recorder/phone-steps.ts` (pure): what a gesture
  meant. `apps/studio/src/server/phone-capture.ts`: the snapshot loop and recorder calls.
- Long press uses the phone's own `long_press_timeout` (300 ms on the test phone, not the
  mirror's 600) and touch slop is 8 dp.
- Keyboard touches are the ones inside the keyboard band of the snapshot before the touch
  or the one at it. They record nothing. A keyboard shows before any snapshot reports it
  (focus at 160 ms, keyboard at 860 ms on the test phone), and a recording there turned the
  first keys into tap steps, so for 1.5 s after focus the lower half of the screen counts as
  keyboard unless a snapshot says otherwise. Only then: a field stays focused once Back hides
  the keyboard, with buttons in the same place.
  Text is read from the focused field on every snapshot, so a paste and autofill count,
  and written at the next gesture. Only the difference is written: `erase`, a new step
  kind emitted as `eraseText`, then `type`. Enter, Go and Search keys record `pressKey`.
- `review` on a step says why it needs a look. Flag rather than guess. Neither snapshot is
  always right: the one at the touch was empty on three correct fast taps, and the one
  before it was stale on a tap 360 ms after a screen change. So a snapshot taken at the
  touch only counts when it names a real element and began within 60 ms of the lift.
- Recording pauses on the launcher or the notification shade, and only there: a permission
  dialog or a browser the app opens are part of the flow. It resumes when the app is
  foreground, and the first step back is flagged.
- Nav buttons are named in snapshots (`com.android.systemui:id/back`, `home`,
  `recent_apps`) and are trusted only with button navigation. With gesture navigation,
  edge swipes are read by where they start.
- A value that changes is a weak selector, and nothing flags it reliably: `text: "44'"`, a
  calculated result, failed on replay once the result had changed. A rule against digits would
  flag keypad buttons, which are stable.
- A node filling 60% of the screen with no visible name is the background, not a control
  (`isScreenContainer`). This applies to the mirror too: a WebView's `root` was being
  written as `tapOn: id: root`, which presses the middle of the screen.

**Security.** getevent is effectively a keylogger: a touch on the keyboard is a key press.
Touches are never logged or stored, keyboard ones are dropped once their place is known,
and text only ever comes from the field. `focusedField` never returns a password field's
value; typing there records `${KEY}` with a `password` review. A test harness once logged
keyboard positions; do not reintroduce that for debugging.

**Xiaomi.** MIUI and HyperOS ask on the phone before each adb install, and stop apps
opening other apps from the background (`MIUILOG- Permission Denied Activity`). Maestro's
driver opens the app that way, so `launchApp` does nothing and Maestro still reports it as
completed. Every case starts with it, so Run refuses with `PHONE_NOT_READY` until **Prepare
this phone** has installed the driver and set MIUI's app operation 10021 on it. Checked on
the POCO: the same `launchApp` flow failed with the operation at `ignore` and passed in 4 s
at `allow`. Runs on these phones pass `--no-reinstall-driver`, because Maestro otherwise
removes the driver after each run, losing that permission and asking to install again. That
flag means "never install": with no driver on the phone Maestro dies with `Device server
died`, so Prepare installs the two APKs itself, from `lib/maestro-client.jar`, with
`adb install -r -t`. A kept driver also stays running, which stops agent-device reading the
screen, so it is force-stopped after each run.

**Samsung.** Tested 2026-11-04 on a Galaxy A16 (SM-A165F, One UI 6.1, Android 14) in Samsung's
Remote Test Lab, through its `rdb` bridge: Connect in 9 s with no prompt, recording from the
screen here, and a Maestro run of 9 of 9 steps with `launchApp`, in 176 s. No Prepare needed.
Browser clicks never reach /dev/input, so **Use the phone** cannot be tested on a remote phone.
Its input devices are a useful trap: `sec_touchpad` reports positions and comes before the
real `sec_touchscreen`, and `sec_touchproximity` is marked direct but reports none. The lab
phone says nothing about Auto Blocker on a customer's own phone. The link dropped seconds after
connecting until the browser tab stayed visible, which fits a hidden tab closing it but was not
proven.

**Other makers.** Every phone gets the same two installs. Research on 2026-11-04 found no
way to read any maker's restrictions over adb, so `deviceProblemIn` recognises them from what
they leave behind: `INSTALL_FAILED_USER_RESTRICTED`, the INJECT_EVENTS exception, and a blocked
launch in the device log. That last one is matched only on Maestro's own launch, because any
app can log the same line, and marking a real failure as a device problem would hide it from
case health. Only Xiaomi and Samsung have been tried; the other notes in the install guide are
from other tools' docs and user reports.

## 16. Milestone 8: writing blocks in the studio

Built 2026-11-07. A BA writes a setup block in the Blocks tab, so a log in no longer waits on a
developer. Tested on an emulator: picked an element, saved, tried, and ran a case through Maestro
with a setting as a tap target and its own values.

The file format does not change. The form saves a Maestro flow to the first folder of
`paths.blocks`, so a block from the form and one from an editor are the same thing to everything
else: the palette, the stack, `runFlow`, CI. `server/blocks.ts` holds the routes.

- A block is editable when Ariadne's parser reads the whole file (`BlockOutline.ownFlow`). That is
  wider than `flow`, which goes away when a Wait or a key sends the block to Maestro.
- `ui/components/block-steps.ts` is the only place that converts between what a form field shows
  and what Maestro reads: a person sees "Display (beta)", the file holds `Display \(beta\)`, and a
  setting is `${NAME}`. A hand-written regular expression stays as it is until someone types over it.
- A step the form has no fields for is kept and can be moved or removed.
- Saving goes through `toMaestroYaml` and back through `parseMaestroFlow`, so nothing is saved that
  would not read as a block. `shared/block-check.ts` holds the rules the UI and the server share.
- Secrets. Typed text equal to a saved value is saved as `${KEY}`. Plain text after a tap on a field
  picked as a password field stops the save; plain text after a tap on something named like a
  password only warns, because the name check also matches "Shopping".
- Pick on the screen is `POST /api/screen/pick`: it resolves a click the way a tap does and presses
  nothing. Taps on the mirror still work outside a recording, so a BA walks to the screen first.
- Try on the device runs from the current screen and records nothing. A block with a Wait goes
  through `runPrefixWithMaestro`, like any block that needs Maestro.
- A setting's default goes to `.env`, never to the block's own `env:` header, which would stop cases
  from setting it (see `recorder/block-values.ts`).
- Delete refuses a block a case or another block uses, as deleting a case with dependents does.

Both other ways into the form go through `caseToFlow`, so recorded steps and hand-added steps are
the same thing by the time the form sees them:

- Record steps (`POST /api/blocks/record`) is an ordinary `Recorder` with `state.recordingBlock` set,
  so every action route, Use the phone and the end checks work unchanged. It differs from a case in
  three ways. It starts from the current screen with no relaunch, because a block can run in the
  middle of a case. It ends in `POST /api/blocks/record/finish`, which drops the leading `launchApp`,
  deletes the evidence and saves no case. And typing into a password field records the setting
  instead of refusing: a case needs a real value to run, while a block only needs the name, and each
  case gives the value. `POST /api/case/finish` refuses such a recording, so it cannot become a case.
- Save as block (`GET /api/cases/:caseId/block-draft`) flattens `startFrom` into one list, because a
  block must not depend on a generated flow. It opens unsaved, so details can become settings first.
- Paths in a block are relative to the block's folder, not the flows folder (`blockFlowPaths`).
- The block routes do their checks inside `enqueue`, and the routes that end a recording check it is
  still the one they were asked about (`requireRecording`). A check before the queue can be overtaken:
  two saves could each pass the loop check, and a case start could leave `recordingBlock` set.
- A password nothing has saved reaches agent-device, whose session log records `type` with no text
  (checked on 2026-11-07). Its errors go unrepeated, because no list of saved values can redact it.
- A save can only add a `runFlow` to a working block of this project; one already in the file stays.
  Listing blocks reads what they run, so an unchecked path would let a request point the studio at
  any file. For the same reason an error about a flow a block runs never quotes that file: the YAML
  library's message includes the line it failed on, which for `.env` would be a saved value.
- A block cannot run itself: Run a setup block now can put any block into a recording, so saving
  follows its `runFlow` steps and refuses one that leads back to its own file (`reachesBlock`). It
  cannot follow a path with a `${VAR}` in it, which Maestro resolves at run time, or a `runFlow`
  inside a command Ariadne does not read. Only a hand-written block can hold either.

## 17. Milestone 9: the evidence pack

Built 2026-11-08. A company with no QA team accepts a release on paper: a BA tests by hand and
writes the evidence up in Word or Excel for a client, an acceptance committee or a change approver.
The evidence pack is that document, made from one finished Run all and titled "Test results report",
the name Greek tenders give the deliverable ("Έκθεση αποτελεσμάτων διενέργειας ελέγχων"). Desk
research on 2026-11-08 found no rule that asks for this exact document, contents that match what
Greek IT tenders (2024 to 2026) and DORA change audits do ask for, and no first-hand demand from
BAs yet, so the pack stays modest until someone asks for more, and it is off by default.

- A project setting, `evidencePack` in `project.json` (`PUT /api/project/evidence-pack`), shows
  **Evidence pack** under the last Run all; the gear menu's "Offer an evidence pack after Run all"
  turns it on. Off unless set. It only hides the button: the route below answers either way, and
  Run all reads `testedOn` either way, so a pack made after turning it on still names the device.

- When Run all starts, `PhoneInputTools.testedOn` reads the phone's maker, model and Android version,
  whether it is an emulator (`ro.kernel.qemu` or `ro.boot.qemu` 1, `ro.hardware` ranchu, goldfish
  or Genymotion's vbox86, maker Genymotion or Genymobile, or "emulator" in
  `ro.build.characteristics`; any other board is a real phone),
  and each app's `versionName` and `versionCode` (`dumpsys package <appId>`), parsed in
  `device/tested-on.ts`, and stores them on the suite as `testedOn`. Read then, not when the pack is
  made, because by then the phone may hold another build. A failure is logged and Run all goes on.
  No serial number: the pack leaves the team.
- `GET /api/suites/:suiteId/evidence` builds the page (`server/evidence.ts`; `export/evidence.ts` for
  the rows and which screen each row shows; `evidenceHtml` in `export/html.ts`), writes
  `exports/evidence-<suiteId>.html` and shows it. Query: `release`, `testedBy`, `conclusion` (200
  characters each), `signoffRole` (40, default "Accepted by"), `knownIssues` (1,000, keeps line
  breaks; the texts travel in the URL and Node refuses a request line over 16 KB), `screens`
  (`all` or `checks`). None is stored on the suite: the file in `exports/` is the record. A suite
  still running is refused with 409.
- The first page is the one to sign: release, app and version, device (real phone or emulator), run
  times, retries, which screens are shown, tester, verdict, known issues, conclusion, every case with
  its result and reference, the two signature rows, and the SHA-256 of `runs/_suites/<id>.json`, read
  once so the hash is of the bytes the pack shows. Then one page per case that ran, built from its
  last attempt: every flow item with its expected result (the step's note or check, as in test case
  documents), its result and the replayed screen, 300 px wide, and the SHA-256 of that run's
  `summary.json`. The step that failed shows Maestro's failure screenshot, because no picture is
  taken after it. With `screens=checks` only checks, end checks and the failed step keep a screen,
  and only those are read from disk.
- The second signature is a role the BA writes, because acceptance is not the BA's to claim: in a
  Greek public contract it is the committee's protocol (Law 4412/2016 art. 219), and under DORA it is
  an approver independent of whoever built the change (RTS 2024/1774 art. 17). A contractor writes
  "Reviewed by".
- A case's `reference` (a requirement, user story or scenario code, at most 100 characters) is set
  from the case header, kept through re-recording and duplicating, and shown in the pack and in test
  case documents. Like rename and mute it does not make runs stale.
- Times are local with their offset, unlike the run reports' UTC, because the pack is signed where it
  is made.
- A case keeps the name it had in Run all. A case edited since says so; one deleted since stays in
  the list with no steps.
- Left for when someone asks: Greek labels, a Word export to paste into a contractor's own template,
  digital signing of the PDF, and a test scenarios document generated from a recording before the
  run (the IKY 2026 template wants a screen with an arrow at the point the user touches).

## 18. Milestone 10: steps as a thread

Built 2026-11-09 from the owner's ask for a better look for blocks and steps with no stock AI
patterns (the coloured side stripe on a rounded tinted card first), a way to remove steps, a way to
wait instead of checking, and a Wait that can be dragged in and does not look like a block.
`docs/steps-redesign.md` is the design and its reasons.

- Every step list is one thread: a hairline down the first column with a mark per row (numbered
  ring for an action, green ring for a check, violet square for a block, no ring and a dotted
  thread for a wait, a filled green dot for an end check). No cards, fills, side stripes or chips
  anywhere in a list. The same rows serve the recording, a saved case, the Before recording stack,
  the palette and the block form.
- Saved cases number rows by step (1 is the first recorded step), so the number on a row is the one
  the row menu and its confirms name. The start and setup blocks before step 1 carry no number.
- While recording, a step can be removed from its row menu or with Delete on a focused row, with
  Undo in the message after it (`DELETE /api/case/steps/:index`, `POST /api/case/steps/restore`).
  The phone is not moved back; when the removed step acted on the phone, a note above Finish says so
  until the case is saved. Steps kept from a saved case during an edit cannot be removed
  (`KEPT_STEP`). Finish deletes the screenshots of steps still removed.
- A Wait can go between any two steps while recording, because it does nothing on the phone: the
  Wait tile at the end of the thread drags into place, and its Add and the row menu give the same
  result by click (`POST /api/case/wait` with `after`; `PATCH /api/case/steps/:index` changes the
  seconds). A block still goes only at the end, because it runs on the phone at once. The toolbar
  under the screen no longer has a Wait: it holds what is recorded by clicking the screen, and a
  wait is not.
- Saved cases get **Add a wait after this step**, **Add a wait before step 1** and **Change the
  seconds** with no recording (`POST /api/cases/:id/steps`, `seconds` on the step patch). They
  mark older runs as before the edit, like Delete step.
- **Wait until** is a new step, recorded from the screen like Check (toolbar toggle, one click, then
  the mode turns itself off): `extendedWaitUntil: { visible: <selector>, timeout }`. It fails the
  run on its own row when the element never shows, so the red lands on the step that explains it
  rather than on the tap after it, and its expected result reads "X appears within N seconds". The
  fixed Wait is the step that never fails. The parser reads back only this form; one with
  `optional: true` stays Maestro's to run. During recording and Try, agent-device does not replay
  it; the studio polls the screen every 500 ms and stops the replay with "Waited N seconds for X and
  it never appeared." The block form offers it too ("Wait until", under More steps).
- Toasts lost their side stripe and gained an optional action (Undo). Section titles are sentence
  case everywhere, dialogs included, instead of small uppercase labels.
- Results are words in their colour with no pill: a tick and Passed in green, a cross and Failed in
  red, Not run in grey; "muted", "flaky" and "failing" are plain coloured words. While recording,
  the bar above the screen says Recording beside its dot and stays untinted, since the ochre frame
  round the screen says it already; nothing is added beside the case title.
- Proven on emulator-5560 against Android Settings: a live recording with a block, a Wait dragged
  between steps 1 and 2 and set to 5 seconds, Remove and Undo, Delete on a focused row, a Wait until
  recorded by clicking the screen, and two Maestro runs of a saved case with a wait before step 1,
  a Wait until that found its element (62 ms) and one that never did (waited 4 s, passed, from when
  it was optional). Once it was made strict, on 2026-11-11 against Fossify Calendar: a run where the
  event was there passed, and one where it was gone failed on the Wait until row after 5.2 s with
  the tap after it not run. Not tried on a real phone or on Windows.

## 19. Later

AI cleanup pass (step titles, selector hardening) with an explicit opt-in and key; voice
narration aligned to steps; iOS simulator through the same agent-device API on macOS;
signed macOS and Windows desktop builds (the Electron app and the npm package exist since
2026-11-03, Linux tested end to end, Windows built and run under Wine); CI recipe with Maestro's `--format junit`; Maestro
`assertScreenshot` as an opt-in hard check for screens that must not change.

## 20. Conventions

- No em dash character anywhere in code, comments, docs or commit messages. Use a comma,
  colon, or parentheses.
- Plain, direct comments. Explain why, not what.
- Secrets never appear in flows, case JSON, logs or screenshots filenames. Typed text that
  goes into a field whose node has `password: true` is recorded as `inputText: ${PASSWORD}`
  style placeholders only in Milestone 2; in Milestone 1, refuse to record into password
  fields and show a toast explaining why.
