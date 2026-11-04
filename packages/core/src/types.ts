// Type-only entry point for browser code: everything here is erased at build
// time, so importing it never pulls agent-device or Node built-ins into a bundle.
export type { HitTestNode, Point, Rect, Viewport } from './device/hit-test.ts';
export type {
  MaestroFlow,
  MaestroKey,
  MaestroOrientation,
  MaestroSelector,
  MaestroStep,
  PercentPoint,
  SwipeDirection,
} from './maestro/model.ts';
export type {
  BlockUse,
  CaseStep,
  Expectation,
  PhoneKey,
  RecordedNode,
  ScreenOrientation,
  ScrollDirection,
  StepReview,
  TestCase,
} from './recorder/case-types.ts';
export type { ExpectationCandidate } from './recorder/expectations.ts';
export type { FlowItem } from './recorder/flow-layout.ts';
export type { RunCommand, RunSummary, StepResult, StepStatus } from './replay/run-result.ts';
export type { CaseHealth, RunDot, SuiteCaseOutcome, SuiteCaseResult, SuiteCounts, SuiteRun } from './replay/suite.ts';
export type { ReportRow } from './export/report.ts';
