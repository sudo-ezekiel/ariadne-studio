import type { ScrollDirection } from '@ariadne/core/types';
import type {
  ActionResponse,
  ApiErrorBody,
  CaseBlockRequest,
  CandidatesResponse,
  CaseDetailResponse,
  CaseFinishResponse,
  CasePatch,
  CaseStartResponse,
  CurrentCaseView,
  DeviceInfo,
  PhonePrepareResponse,
  PhoneStatus,
  EditRequest,
  FileContent,
  FileListResponse,
  FileRootsResponse,
  KeyRequest,
  PinchRequest,
  ProjectInfo,
  RotateRequest,
  RunView,
  ScreenState,
  SessionInfo,
  SetupInfo,
  StepPatch,
  SuiteView,
  SwipeRequest,
} from '../shared/api-types.ts';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    throw new ApiError(error?.code ?? 'HTTP_ERROR', error?.message ?? `${method} ${url} failed (${response.status})`, response.status);
  }
  return data as T;
}

const caseUrl = (caseId: string) => `/api/cases/${encodeURIComponent(caseId)}`;

export type ExportFormat = 'md' | 'html' | 'xlsx';

export const api = {
  project: () => request<ProjectInfo>('GET', '/api/project'),
  fileRoots: () => request<FileRootsResponse>('GET', '/api/files'),
  fileList: (path: string) => request<FileListResponse>('GET', `/api/files/list?path=${encodeURIComponent(path)}`),
  fileContent: (path: string) => request<FileContent>('GET', `/api/files/content?path=${encodeURIComponent(path)}`),
  setAppId: (appId: string) => request<ProjectInfo>('PUT', '/api/project', { appId }),
  setRunVideo: (on: boolean) => request<ProjectInfo>('PUT', '/api/project/run-video', { on }),
  devices: () => request<DeviceInfo[]>('GET', '/api/devices'),
  session: () => request<SessionInfo>('GET', '/api/session'),
  open: (deviceId: string, appId: string) => request<ScreenState>('POST', '/api/session/open', { deviceId, appId }),
  close: () => request<{ ok: true }>('POST', '/api/session/close'),
  screen: () => request<ScreenState>('GET', '/api/screen'),
  tap: (x: number, y: number) => request<ActionResponse>('POST', '/api/action/tap', { x, y }),
  type: (text: string) => request<ActionResponse>('POST', '/api/action/type', { text }),
  back: () => request<ActionResponse>('POST', '/api/action/back'),
  scroll: (direction: ScrollDirection) => request<ActionResponse>('POST', '/api/action/scroll', { direction }),
  relaunch: () => request<ActionResponse>('POST', '/api/action/relaunch'),
  openLink: (url: string) => request<ActionResponse>('POST', '/api/action/open-link', { url }),
  hideKeyboard: () => request<ActionResponse>('POST', '/api/action/hide-keyboard'),
  longPress: (x: number, y: number) => request<ActionResponse>('POST', '/api/action/long-press', { x, y }),
  doubleTap: (x: number, y: number) => request<ActionResponse>('POST', '/api/action/double-tap', { x, y }),
  swipe: (swipe: SwipeRequest) => request<ActionResponse>('POST', '/api/action/swipe', swipe),
  pressKey: (key: KeyRequest['key']) => request<ActionResponse>('POST', '/api/action/key', { key }),
  rotate: (orientation: RotateRequest['orientation']) => request<ActionResponse>('POST', '/api/action/rotate', { orientation }),
  pinch: (zoom: PinchRequest['zoom']) => request<ActionResponse>('POST', '/api/action/pinch', { zoom }),
  expect: (x: number, y: number) => request<ActionResponse>('POST', '/api/case/expect', { x, y }),
  startCase: (name: string, start: { blocks: CaseBlockRequest[] } | { startFrom: string }) =>
    request<CaseStartResponse>('POST', '/api/case/start', { name, ...start }),
  runBlock: (use: CaseBlockRequest) => request<ActionResponse>('POST', '/api/case/block', use),
  addTestUser: (name: string, values: Record<string, string>) => request<ProjectInfo>('POST', '/api/project/test-users', { name, values }),
  candidates: () => request<CandidatesResponse>('GET', '/api/case/candidates'),
  finishCase: (picks: number[]) => request<CaseFinishResponse>('POST', '/api/case/finish', { picks }),
  discardCase: () => request<{ ok: true; restored?: boolean }>('POST', '/api/case/discard'),
  currentCase: () => request<CurrentCaseView | null>('GET', '/api/case/current'),
  diagnosticsUrl: (screenshots: boolean) => `/api/diagnostics${screenshots ? '?screenshots=1' : ''}`,
  phone: () => request<PhoneStatus>('GET', '/api/phone'),
  phoneStart: () => request<PhoneStatus>('POST', '/api/phone/start'),
  phoneStop: () => request<PhoneStatus>('POST', '/api/phone/stop'),
  preparePhone: (deviceId: string) => request<PhonePrepareResponse>('POST', '/api/phone/prepare', { deviceId }),
  caseDetail: (caseId: string) => request<CaseDetailResponse>('GET', caseUrl(caseId)),
  patchCase: (caseId: string, patch: CasePatch) => request<CaseDetailResponse>('PATCH', caseUrl(caseId), patch),
  patchStep: (caseId: string, index: number, patch: StepPatch) =>
    request<CaseDetailResponse>('PATCH', `${caseUrl(caseId)}/steps/${index}`, patch),
  deleteStep: (caseId: string, index: number) => request<CaseDetailResponse>('DELETE', `${caseUrl(caseId)}/steps/${index}`),
  deleteExpectation: (caseId: string, position: number) =>
    request<CaseDetailResponse>('DELETE', `${caseUrl(caseId)}/expectations/${position}`),
  splitCase: (caseId: string, atStep: number) => request<CaseDetailResponse>('POST', `${caseUrl(caseId)}/split`, { atStep }),
  duplicateCase: (caseId: string) => request<CaseDetailResponse>('POST', `${caseUrl(caseId)}/duplicate`, {}),
  editCase: (caseId: string, edit: EditRequest) => request<CaseStartResponse>('POST', `${caseUrl(caseId)}/edit`, edit),
  replayCase: (caseId: string) => request<RunView>('POST', `${caseUrl(caseId)}/replay`),
  deleteCase: (caseId: string) => request<{ ok: true }>('DELETE', caseUrl(caseId)),
  runAll: (retryFailed: boolean) => request<SuiteView>('POST', '/api/suite/run', { retryFailed }),
  stopSuite: () => request<SuiteView>('POST', '/api/suite/stop'),
  currentSuite: () => request<SuiteView | null>('GET', '/api/suite/current'),
  setup: () => request<SetupInfo>('GET', '/api/setup'),
  startEmulator: (name: string) => request<{ ok: true; name: string }>('POST', '/api/setup/emulator', { name }),
  caseExportUrl: (caseId: string, format: ExportFormat) => `${caseUrl(caseId)}/export?format=${format}`,
  projectExportUrl: (format: ExportFormat) => `/api/export?format=${format}`,
};
