import { useCallback, useEffect, useRef, useState } from 'react';
import type { Point, Rect } from '@ariadne/core/hit-test';
import type { ExpectationCandidate, PhoneKey, ScreenOrientation, ScrollDirection } from '@ariadne/core/types';
import type {
  ActionResponse,
  CaseDetailResponse,
  CaseFinishResponse,
  CurrentCaseView,
  DeviceInfo,
  EditRequest,
  FileContent,
  PhoneStatus,
  ProjectInfo,
  ScreenState,
  SessionInfo,
  StepPatch,
  SuiteView,
} from '../shared/api-types.ts';
import { api, ApiError } from './api.ts';
import { CasePanel, type Draft, type PanelTab } from './components/CasePanel.tsx';
import { ConnectionCard } from './components/ConnectionCard.tsx';
import { FilesPanel, useFilesOpen } from './components/FilesPanel.tsx';
import { Mirror } from './components/Mirror.tsx';
import { SetupDialog } from './components/SetupDialog.tsx';
import { Toasts, type Toast } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { useTheme } from './theme.ts';

const HIGHLIGHT_MS = 1000;
const TOAST_MS = 8000;
const SUITE_POLL_MS = 1500;
const PHONE_POLL_MS = 600;
const PHONE_OFF: PhoneStatus = { active: false, paused: false, revision: 0 };

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [appId, setAppId] = useState('');
  const [session, setSession] = useState<SessionInfo>({ open: false });
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const [currentCase, setCurrentCase] = useState<CurrentCaseView | null>(null);
  const [finished, setFinished] = useState<CaseFinishResponse | null>(null);
  const [picking, setPicking] = useState<{ candidates: ExpectationCandidate[]; preselected?: number[] } | null>(null);
  const [openedCase, setOpenedCase] = useState<CaseDetailResponse | null>(null);
  const [suite, setSuite] = useState<SuiteView | null>(null);
  const [expectMode, setExpectMode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Rect | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tab, setTab] = useState<PanelTab>('record');
  const [draft, setDraft] = useState<Draft>({ name: '', startFrom: '', blocks: [] });
  const [nameFocus, setNameFocus] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const [phone, setPhone] = useState<PhoneStatus>(PHONE_OFF);
  const [openedFile, setOpenedFile] = useState<FileContent | null>(null);
  const [filesOpen, toggleFiles] = useFilesOpen();
  const { choice: themeChoice, theme, setChoice: setThemeChoice } = useTheme();
  const toastId = useRef(0);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'error') => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, message, kind }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), TOAST_MS);
  }, []);

  /** Runs one server call at a time and turns failures into toasts. */
  const run = useCallback(
    async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      try {
        return await task();
      } catch (error) {
        const message = error instanceof ApiError ? `${error.message} [${error.code}]` : String(error);
        toast(message);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const loadDevices = useCallback(async () => {
    const list = await api.devices();
    setDevices(list);
    setDeviceId((current) => (current && list.some((device) => device.id === current) ? current : (list[0]?.id ?? '')));
    return list;
  }, []);

  useEffect(() => {
    void run('Loading', async () => {
      const [info, sessionInfo, active, lastSuite, phoneNow] = await Promise.all([api.project(), api.session(), api.currentCase(), api.currentSuite(), api.phone()]);
      setPhone(phoneNow);
      setProject(info);
      setAppId(info.appId);
      setSession(sessionInfo);
      setCurrentCase(active);
      setSuite(lastSuite);
      const list = await loadDevices();
      const preferred = sessionInfo.deviceId ?? info.lastDeviceId;
      if (preferred && list.some((device) => device.id === preferred)) setDeviceId(preferred);
      if (sessionInfo.open) setScreen(await api.screen().catch(() => null));
    });
  }, [run, loadDevices]);

  // Expect mode and the picker belong to the case being recorded, and a recording lives in the Record tab.
  const recordingId = currentCase?.id;
  useEffect(() => {
    if (!recordingId) {
      setExpectMode(false);
      setPicking(null);
      setPhone(PHONE_OFF);
    } else {
      setTab('record');
    }
  }, [recordingId]);

  // Run all goes on in the server; poll it while it runs, then refresh what it changed.
  const suiteRunning = suite?.status === 'running';
  const openedId = useRef<string | undefined>(undefined);
  openedId.current = openedCase?.case.id;
  useEffect(() => {
    if (!suiteRunning) return;
    const timer = setInterval(() => {
      void api
        .currentSuite()
        .then(async (next) => {
          setSuite(next);
          if (next?.status !== 'running') {
            setProject(await api.project());
            const sessionInfo = await api.session();
            setSession(sessionInfo);
            setScreen(sessionInfo.open ? await api.screen().catch(() => null) : null);
            const opened = openedId.current;
            if (opened) setOpenedCase(await api.caseDetail(opened).catch(() => null));
          }
        })
        .catch(() => undefined);
    }, SUITE_POLL_MS);
    return () => clearInterval(timer);
  }, [suiteRunning]);

  // Steps made on the phone arrive from the server; follow them while the tester is using it.
  const phoneActive = phone.active;
  const phoneRevision = useRef(0);
  const phoneNotice = useRef(0);
  useEffect(() => {
    if (!phoneActive) return;
    const timer = setInterval(() => {
      void api
        .phone()
        .then(async (next) => {
          setPhone(next);
          if (next.notice && next.notice.id !== phoneNotice.current) {
            phoneNotice.current = next.notice.id;
            toast(next.notice.text, 'info');
          }
          if (!next.active && next.error) toast(next.error);
          if (next.active && next.revision === phoneRevision.current) return;
          phoneRevision.current = next.revision;
          setCurrentCase(await api.currentCase());
          setScreen(await api.screen().catch(() => null));
        })
        .catch(() => undefined);
    }, PHONE_POLL_MS);
    return () => clearInterval(timer);
  }, [phoneActive, toast]);

  const togglePhone = () =>
    run(phone.active ? 'Stopping' : 'Getting ready', async () => {
      setPhone(phone.active ? await api.phoneStop() : await api.phoneStart());
      setCurrentCase(await api.currentCase());
      setScreen(await api.screen().catch(() => null));
    });

  // Closing a file goes back to the tab that was showing before it.
  const lastTab = useRef<PanelTab>('record');
  useEffect(() => {
    if (tab !== 'file') lastTab.current = tab;
  }, [tab]);

  const closeFile = useCallback(() => {
    setOpenedFile(null);
    setTab((current) => (current === 'file' ? lastTab.current : current));
  }, []);

  // Not through run(): reading a file must not end the busy state of a device action in progress.
  const openFile = useCallback(
    (path: string) => {
      api
        .fileContent(path)
        .then((file) => {
          setOpenedFile(file);
          setTab('file');
        })
        .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error)));
    },
    [toast],
  );

  const setRunVideo = (on: boolean) => {
    api
      .setRunVideo(on)
      .then(setProject)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error)));
  };

  // A save or a run can rewrite or remove the open file, and project changes after both.
  const openedFilePath = useRef<string | undefined>(undefined);
  openedFilePath.current = openedFile?.path;
  useEffect(() => {
    const path = openedFilePath.current;
    if (path) void api.fileContent(path).then(setOpenedFile).catch(closeFile);
  }, [project, closeFile]);

  const applyAction = useCallback(async (response: ActionResponse) => {
    setScreen(response.screen);
    if (response.resolved?.rect) {
      setHighlight(response.resolved.rect);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    }
    if (response.step) setCurrentCase(await api.currentCase());
  }, []);

  const open = () =>
    run('Connecting', async () => {
      const next = await api.open(deviceId, appId.trim());
      setScreen(next);
      setSession(await api.session());
      setProject(await api.project());
    });

  const close = () =>
    run('Disconnecting', async () => {
      await api.close();
      setSession({ open: false });
      setScreen(null);
    });

  const tap = (point: Point) => run('Tapping', async () => applyAction(await api.tap(point.x, point.y)));
  const type = (text: string) => run('Typing', async () => applyAction(await api.type(text)));
  const back = () => run('Going back', async () => applyAction(await api.back()));
  const scroll = (direction: ScrollDirection) => run('Scrolling', async () => applyAction(await api.scroll(direction)));
  const expectAt = (point: Point) => run('Recording check', async () => applyAction(await api.expect(point.x, point.y)));
  const relaunch = () => run('Relaunching', async () => applyAction(await api.relaunch()));
  const hideKeyboard = () => run('Hiding the keyboard', async () => applyAction(await api.hideKeyboard()));
  const openLink = (url: string) => run('Opening link', async () => applyAction(await api.openLink(url)));
  const longPress = (point: Point) => run('Long pressing', async () => applyAction(await api.longPress(point.x, point.y)));
  const doubleTap = (point: Point) => run('Double tapping', async () => applyAction(await api.doubleTap(point.x, point.y)));
  const swipe = (from: Point, to: Point, durationMs: number) =>
    run('Swiping', async () => applyAction(await api.swipe({ from, to, durationMs })));
  const pressKey = (key: PhoneKey | 'appSwitch') => run('Pressing the button', async () => applyAction(await api.pressKey(key)));
  const rotate = (orientation: ScreenOrientation) => run('Rotating', async () => applyAction(await api.rotate(orientation)));
  const zoom = (direction: 'in' | 'out') => run('Zooming', async () => applyAction(await api.pinch(direction)));
  const runBlock = (file: string, values: Record<string, string> | undefined) =>
    run('Running the block', async () => {
      try {
        await applyAction(await api.runBlock(values ? { file, values } : { file }));
      } catch (error) {
        // A failed block leaves the device where it stopped; show that screen.
        setScreen(await api.screen().catch(() => null));
        throw error;
      }
    });

  /** Saves a test user to .env and reloads the project so blocks offer it. */
  const addTestUser = async (name: string, values: Record<string, string>): Promise<boolean> =>
    (await run('Saving the test user', async () => {
      setProject(await api.addTestUser(name, values));
      toast(`Saved the test user ${name}.`, 'info');
      return true;
    })) ?? false;

  /** Starts recording the draft from the Record tab; without a name, asks for one first. */
  const record = () => {
    const name = draft.name.trim();
    if (!name) {
      setTab('record');
      setNameFocus((current) => current + 1);
      return;
    }
    const cases = project?.cases ?? [];
    const startFrom = draft.startFrom && cases.some((item) => item.id === draft.startFrom) ? draft.startFrom : '';
    const usable = new Set((project?.blocks ?? []).filter((block) => !block.error).map((block) => block.file));
    const start = startFrom ? { startFrom } : { blocks: draft.blocks.filter((use) => usable.has(use.file)) };
    void run('startFrom' in start ? 'Running the starting case' : start.blocks.length > 0 ? 'Running setup blocks' : 'Starting recording', async () => {
      try {
        const started = await api.startCase(name, start);
        setScreen(started.screen);
        setFinished(null);
        setOpenedCase(null);
        setNameFocus(0);
        // Keep what runs first: the next case often starts the same way.
        setDraft((current) => ({ ...current, name: '' }));
        setCurrentCase(await api.currentCase());
      } catch (error) {
        // A failed block leaves the device where it stopped; show that screen.
        setScreen(await api.screen().catch(() => null));
        throw error;
      }
    });
  };

  const saveCase = (picks: number[]) =>
    run('Saving case', async () => {
      const result = await api.finishCase(picks);
      const wasEditing = currentCase?.editing !== undefined;
      setPicking(null);
      setCurrentCase(null);
      setProject(await api.project());
      if (wasEditing) {
        setFinished(null);
        setOpenedCase(await api.caseDetail(result.caseId));
        setTab('cases');
      } else {
        setFinished(result);
      }
    });

  const finishCase = () => {
    // Steps inserted in the middle keep the case's end checks; nothing to pick.
    if (currentCase?.editing?.mode === 'insert') {
      void saveCase([]);
      return;
    }
    void run('Finding end checks', async () => {
      if (phone.active) {
        setPhone(await api.phoneStop());
        setCurrentCase(await api.currentCase());
        setScreen(await api.screen().catch(() => null));
      }
      const response = await api.candidates();
      setPicking({ candidates: response.candidates, ...(response.preselected ? { preselected: response.preselected } : {}) });
    });
  };

  const openCase = (caseId: string) =>
    run('Opening case', async () => {
      setFinished(null);
      setOpenedCase(await api.caseDetail(caseId));
      setTab('cases');
    });

  const replayCase = (caseId: string) =>
    run('Running', async () => {
      try {
        await api.replayCase(caseId);
        setFinished(null);
        setOpenedCase(await api.caseDetail(caseId));
      } finally {
        // Replay closes the device session for Maestro and reopens it afterwards.
        const sessionInfo = await api.session();
        setSession(sessionInfo);
        setScreen(sessionInfo.open ? await api.screen().catch(() => null) : null);
        setProject(await api.project());
      }
    });

  /** Runs a change to a saved case and shows the case as it is afterwards. */
  const changeCase = (label: string, task: () => Promise<CaseDetailResponse>) =>
    void run(label, async () => {
      const next = await task();
      setOpenedCase(next);
      setProject(await api.project());
    });

  const editCase = (caseId: string, edit: EditRequest) =>
    void run('Running up to the step', async () => {
      try {
        const started = await api.editCase(caseId, edit);
        setScreen(started.screen);
        setOpenedCase(null);
        setFinished(null);
        setCurrentCase(await api.currentCase());
      } catch (error) {
        setScreen(await api.screen().catch(() => null));
        throw error;
      }
    });

  const runAll = (retryFailed: boolean) =>
    void run('Starting Run all', async () => {
      setSuite(await api.runAll(retryFailed));
    });

  const stopSuite = () =>
    void run('Stopping Run all', async () => {
      setSuite(await api.stopSuite());
    });

  const deleteCase = (caseId: string) => {
    if (!window.confirm('Delete this case, its flow file, its screenshots and its replay results?')) return;
    void run('Deleting case', async () => {
      await api.deleteCase(caseId);
      setOpenedCase((current) => (current?.case.id === caseId ? null : current));
      setProject(await api.project());
      toast('Case deleted.', 'info');
    });
  };

  const discardCase = () => {
    const editing = currentCase?.editing;
    const message = editing ? 'Discard these changes? The saved case stays as it was.' : 'Discard this case and its screenshots?';
    if (!window.confirm(message)) return;
    void run('Discarding', async () => {
      const result = await api.discardCase();
      const caseId = currentCase?.id;
      setCurrentCase(null);
      setPicking(null);
      if (result.restored && caseId) {
        setOpenedCase(await api.caseDetail(caseId));
        setTab('cases');
      }
      toast(result.restored ? 'Changes discarded.' : 'Case discarded.', 'info');
    });
  };

  // Installs on a real phone ask on its own screen, and the prompt closes by itself within seconds.
  const device = devices.find((item) => item.id === (session.deviceId ?? deviceId));
  const realPhone = device !== undefined && device.kind !== 'emulator';
  const phonePrompt = !realPhone ? null : busy === 'Connecting' ? 'connect' : busy?.startsWith('Run') || suiteRunning ? 'run' : null;

  return (
    <div className="app">
      <TopBar
        session={session}
        busy={busy}
        theme={theme}
        themeChoice={themeChoice}
        onThemeChoice={setThemeChoice}
        onOpenSetup={() => setSetupOpen(true)}
        filesOpen={filesOpen}
        onToggleFiles={toggleFiles}
        runVideo={project?.runVideo ?? false}
        videoHasSteps={project?.videoHasSteps ?? true}
        onRunVideo={setRunVideo}
      />
      <main className="workspace">
        <Mirror
          screen={screen}
          busy={busy !== null || picking !== null || suiteRunning}
          highlight={highlight}
          sessionOpen={session.open}
          caseActive={currentCase !== null}
          recording={currentCase ? { name: currentCase.name, steps: currentCase.steps.length } : null}
          phone={phone}
          phonePrompt={phonePrompt}
          onTogglePhone={() => void togglePhone()}
          picking={picking !== null}
          suiteRunning={suiteRunning}
          devicesFound={devices.length > 0}
          appId={session.appId}
          onRecord={record}
          onFinish={() => void finishCase()}
          onOpenSetup={() => setSetupOpen(true)}
          expectMode={expectMode}
          onTap={(point) => void tap(point)}
          onExpect={(point) => void expectAt(point)}
          onToggleExpect={() => setExpectMode((current) => !current)}
          onType={(text) => void type(text)}
          onBack={() => void back()}
          onScroll={(direction) => void scroll(direction)}
          onRelaunch={() => void relaunch()}
          onHideKeyboard={() => void hideKeyboard()}
          onOpenLink={(url) => void openLink(url)}
          onLongPress={(point) => void longPress(point)}
          onDoubleTap={(point) => void doubleTap(point)}
          onSwipe={(from, to, durationMs) => void swipe(from, to, durationMs)}
          onKey={(key) => void pressKey(key)}
          onRotate={(orientation) => void rotate(orientation)}
          onZoom={(direction) => void zoom(direction)}
        />
        <div className="side">
          <ConnectionCard
            devices={devices}
            deviceId={deviceId}
            appId={appId}
            session={session}
            busy={busy}
            caseActive={currentCase !== null}
            onDeviceChange={setDeviceId}
            onAppIdChange={setAppId}
            onRefreshDevices={() => void run('Listing devices', loadDevices)}
            onOpen={() => void open()}
            onClose={() => void close()}
            onOpenSetup={() => setSetupOpen(true)}
          />
          <CasePanel
            tab={tab}
            onTabChange={setTab}
            openedFile={openedFile}
            onCloseFile={closeFile}
            draft={draft}
            onDraftChange={setDraft}
            nameFocus={nameFocus}
            appId={session.appId ?? appId}
            project={project}
            currentCase={currentCase}
            finished={finished}
            picking={picking}
            openedCase={openedCase}
            suite={suite}
            busy={busy !== null || suiteRunning}
            sessionOpen={session.open}
            usingPhone={phone.active}
            onRecord={record}
            onRunBlock={(file, values) => void runBlock(file, values)}
            onAddTestUser={addTestUser}
            onFinish={() => void finishCase()}
            onSavePicks={(picks) => void saveCase(picks)}
            onCancelPick={() => setPicking(null)}
            onDiscard={discardCase}
            onDismissFinished={() => setFinished(null)}
            onOpenCase={(caseId) => void openCase(caseId)}
            onCloseCase={() => setOpenedCase(null)}
            onReplayCase={(caseId) => void replayCase(caseId)}
            onRunAll={runAll}
            onStopSuite={stopSuite}
            caseActions={{
              onEdit: editCase,
              onOpenCase: (caseId) => void openCase(caseId),
              onRename: (caseId, name) => changeCase('Renaming', () => api.patchCase(caseId, { name })),
              onMute: (caseId, muted) => changeCase(muted ? 'Muting' : 'Unmuting', () => api.patchCase(caseId, { muted })),
              onDuplicate: (caseId) => changeCase('Duplicating', () => api.duplicateCase(caseId)),
              onDelete: deleteCase,
              onPatchStep: (caseId, index, patch: StepPatch) => changeCase('Saving the step', () => api.patchStep(caseId, index, patch)),
              onDeleteStep: (caseId, index) => changeCase('Deleting the step', () => api.deleteStep(caseId, index)),
              onDeleteExpectation: (caseId, position) => changeCase('Deleting the check', () => api.deleteExpectation(caseId, position)),
              onSplit: (caseId, atStep) => changeCase('Splitting', () => api.splitCase(caseId, atStep)),
            }}
          />
        </div>
        <FilesPanel hidden={!filesOpen} project={project} openedPath={openedFile?.path} onOpenFile={openFile} onClose={toggleFiles} onError={toast} />
      </main>
      {project && (
        <footer className="footer">
          Project {project.dir} · {project.cases.length} {project.cases.length === 1 ? 'case' : 'cases'} · flows go to {project.paths.flows}
        </footer>
      )}
      <SetupDialog
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          void loadDevices().catch(() => undefined);
        }}
        onDevicesChanged={() => void loadDevices().catch(() => undefined)}
      />
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))} />
    </div>
  );
}
