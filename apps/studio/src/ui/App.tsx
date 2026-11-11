import { useCallback, useEffect, useRef, useState } from 'react';
import type { Point, Rect } from '@ariadne/core/hit-test';
import type { ExpectationCandidate, PhoneKey, ScreenOrientation, ScrollDirection } from '@ariadne/core/types';
import {
  DEFAULT_WAIT_SECONDS,
  type ActionResponse,
  type CaseDetailResponse,
  type CaseFinishResponse,
  type CurrentCaseView,
  type DeviceInfo,
  type EditRequest,
  type FileContent,
  type PhoneStatus,
  type ProjectInfo,
  type ScreenState,
  type SessionInfo,
  type StepPatch,
  type StepView,
  type SuiteView,
} from '../shared/api-types.ts';
import { opensByItself } from '../shared/setup-steps.ts';
import { api, ApiError } from './api.ts';
import { blockFromCase, buildSteps, editFromDetail, isDirty, newBlock, pickedStep, withRecordedSteps, type BlockEdit } from './components/block-steps.ts';
import { CasePanel, type Draft, type PanelTab } from './components/CasePanel.tsx';
import { ConnectionCard } from './components/ConnectionCard.tsx';
import { FilesPanel, useFilesOpen } from './components/FilesPanel.tsx';
import { Mirror } from './components/Mirror.tsx';
import { SetupDialog } from './components/SetupDialog.tsx';
import { actsOnPhone } from './components/step-marks.ts';
import { Toasts, type Toast } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { useTheme } from './theme.ts';

const HIGHLIGHT_MS = 1000;
const TOAST_MS = 8000;
const SUITE_POLL_MS = 1500;
const PHONE_POLL_MS = 600;
/** The wait between looks at the phone, each of which takes a couple of seconds itself. */
const LIVE_SCREEN_MS = 1500;
/** A phone that stopped answering, as when it is unplugged, is not worth asking as often. */
const LIVE_SCREEN_FAILED_MS = 10_000;
const PHONE_OFF: PhoneStatus = { active: false, following: false, paused: false, revision: 0 };
/** Whether a recording also reads the phone's own touchscreen. A choice for this computer, not the project. */
const FOLLOW_PHONE_KEY = 'ariadne-follow-phone';

function readFollowPhone(): boolean {
  try {
    return localStorage.getItem(FOLLOW_PHONE_KEY) !== 'off';
  } catch {
    return true;
  }
}

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
  const [waitUntilMode, setWaitUntilMode] = useState(false);
  /** The wait in the recording whose seconds field is open, by step number. */
  const [changingWait, setChangingWait] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Rect | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tab, setTab] = useState<PanelTab>('record');
  const [draft, setDraft] = useState<Draft>({ name: '', startFrom: '', blocks: [] });
  // Up here so a block being written survives a look at another tab.
  const [blockEdit, setBlockEdit] = useState<BlockEdit | null>(null);
  const [pickingKey, setPickingKey] = useState<number | null>(null);
  const [nameFocus, setNameFocus] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const [phone, setPhone] = useState<PhoneStatus>(PHONE_OFF);
  const [followPhone, setFollowPhoneChoice] = useState(readFollowPhone);
  const [openedFile, setOpenedFile] = useState<FileContent | null>(null);
  const [filesOpen, toggleFiles] = useFilesOpen();
  const { choice: themeChoice, theme, setChoice: setThemeChoice } = useTheme();
  const toastId = useRef(0);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'error', action?: Toast['action']) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, message, kind, ...(action ? { action } : {}) }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), TOAST_MS);
  }, []);
  /** The server puts back only the step removed last, and only while recording, so older Undo buttons must go. */
  const dropUndo = useCallback(() => setToasts((current) => current.filter((item) => item.action?.label !== 'Undo')), []);
  const recording = currentCase !== null;
  useEffect(() => {
    if (!recording) dropUndo();
  }, [recording, dropUndo]);

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
      // No adb yet is what the setup guide below is for, not an error to show.
      const list = await loadDevices().catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'TOOL_MISSING') return [];
        throw error;
      });
      const preferred = sessionInfo.deviceId ?? info.lastDeviceId;
      if (preferred && list.some((device) => device.id === preferred)) setDeviceId(preferred);
      if (sessionInfo.open) setScreen(await api.screen().catch(() => null));
      const setup = await api.setup().catch(() => null);
      if (setup && opensByItself(setup, sessionInfo.open, info.lastDeviceId)) setSetupOpen(true);
    });
  }, [run, loadDevices]);

  // Picking belongs to the form, so it ends when the form is out of sight.
  useEffect(() => {
    if (tab !== 'blocks') setPickingKey(null);
  }, [tab]);

  // Expect mode and the picker belong to the case being recorded, and a recording lives in the Record tab.
  const recordingId = currentCase?.id;
  useEffect(() => {
    if (!recordingId) {
      setExpectMode(false);
      setWaitUntilMode(false);
      setChangingWait(null);
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

  // The phone changes without telling anyone: an app hands over to a website, a person closes
  // it, it goes to sleep. So the screen here keeps looking. It stops for anything that needs
  // the device, or that reads what is on screen, and while nobody can see this window.
  const liveScreen = session.open && busy === null && picking === null && !phone.following && !suiteRunning;
  useEffect(() => {
    if (!liveScreen) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      let wait = LIVE_SCREEN_MS;
      if (!document.hidden) {
        try {
          const next = await api.refreshScreen();
          if (alive) setScreen(next);
        } catch {
          wait = LIVE_SCREEN_FAILED_MS;
        }
      }
      if (alive) timer = setTimeout(() => void look(), wait);
    };
    timer = setTimeout(() => void look(), LIVE_SCREEN_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [liveScreen]);
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

  // A recording reads the phone's own touchscreen too, so the phone works as well as the screen here,
  // with no switch between them. Once per recording: a phone that cannot be read, or that stopped
  // sending touches, is not asked again until the next one.
  const phoneTriedFor = useRef<string | undefined>(undefined);
  /** The setting and the recording as they are now, for a start that settles after either changed. */
  const followPhoneNow = useRef(followPhone);
  followPhoneNow.current = followPhone;
  const recordingNow = useRef(recordingId);
  recordingNow.current = recordingId;
  useEffect(() => {
    if (!recordingId || !followPhone || !session.open || phone.active || phoneTriedFor.current === recordingId) return;
    phoneTriedFor.current = recordingId;
    api
      .phoneStart()
      .then((next) => {
        if (recordingNow.current !== recordingId) return;
        // Turned off while the phone was being started: stop it rather than follow it.
        if (!followPhoneNow.current) {
          if (next.active) void api.phoneStop().then(setPhone, () => undefined);
          return;
        }
        setPhone(next);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'NO_TOUCHSCREEN') return;
        toast(`Only the screen here records this time: ${error instanceof Error ? error.message : String(error)}`, 'info');
      });
  }, [recordingId, followPhone, session.open, phone.active, toast]);

  const setFollowPhone = (on: boolean) => {
    try {
      localStorage.setItem(FOLLOW_PHONE_KEY, on ? 'on' : 'off');
    } catch {
      // Private windows may refuse; the choice then lasts until the page closes.
    }
    setFollowPhoneChoice(on);
    followPhoneNow.current = on;
    if (on) phoneTriedFor.current = undefined;
    else if (phone.active) void api.phoneStop().then(setPhone, () => undefined);
  };

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

  const setEvidencePack = (on: boolean) => {
    api
      .setEvidencePack(on)
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
  const refreshScreen = () => run('Refreshing', async () => setScreen(await api.refreshScreen()));
  const type = (text: string) => run('Typing', async () => applyAction(await api.type(text)));
  const back = () => run('Going back', async () => applyAction(await api.back()));
  const scroll = (direction: ScrollDirection) => run('Scrolling', async () => applyAction(await api.scroll(direction)));
  const expectAt = (point: Point) => run('Recording check', async () => applyAction(await api.expect(point.x, point.y)));
  const relaunch = () => run('Relaunching', async () => applyAction(await api.relaunch()));
  const hideKeyboard = () => run('Hiding the keyboard', async () => applyAction(await api.hideKeyboard()));
  const openLink = (url: string) => run('Opening link', async () => applyAction(await api.openLink(url)));
  const waitUntilAt = (point: Point) =>
    run('Recording a wait', async () => {
      setWaitUntilMode(false);
      const response = await api.waitFor(point.x, point.y);
      await applyAction(response);
      if (response.step) setChangingWait(response.step.index);
    });
  const insertWait = (after: number) =>
    run('Adding a wait', async () => {
      const response = await api.insertWait(DEFAULT_WAIT_SECONDS, after);
      setCurrentCase(await api.currentCase());
      if (response.step) setChangingWait(response.step.index);
      return response.step?.index;
    });
  const restoreStep = () =>
    run('Putting the step back', async () => {
      setCurrentCase(await api.restoreStep());
      // Later steps move down by one, so an open seconds field would now be on another row.
      setChangingWait(null);
    });
  const removeStep = (step: StepView) =>
    run('Removing the step', async () => {
      setCurrentCase(await api.removeStep(step.index));
      setChangingWait(null);
      const message = actsOnPhone(step.kind) ? `Step ${step.index} removed. The phone is still where that step left it.` : `Step ${step.index} removed.`;
      dropUndo();
      toast(message, 'info', { label: 'Undo', run: () => void restoreStep() });
    });
  const setWaitSeconds = (index: number, seconds: number) =>
    run('Changing the wait', async () => setCurrentCase(await api.setStepSeconds(index, seconds)));
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

  /** Saves a setting's value to .env and reloads the project so the block shows it as saved. */
  const addSavedValue = async (name: string, value: string): Promise<boolean> =>
    (await run('Saving the value', async () => {
      setProject(await api.addSavedValues({ [name]: value }));
      return true;
    })) ?? false;

  const openBlock = (file: string) =>
    run('Opening the block', async () => {
      setBlockEdit(editFromDetail(await api.blockDetail(file)));
    });

  /** Not through run(): Save and try goes on to the device under the same busy state. */
  const writeBlock = async (edit: BlockEdit): Promise<string> => {
    const block = { name: edit.name.trim(), steps: buildSteps(edit.steps) };
    const detail = edit.file ? await api.saveBlock(edit.file, block) : await api.createBlock({ ...block, appId: edit.appId ?? (session.appId ?? appId).trim() });
    setBlockEdit({ ...editFromDetail(detail), ...(edit.values ? { values: edit.values } : {}) });
    setPickingKey(null);
    setProject(await api.project());
    return detail.file;
  };

  const saveBlock = (edit: BlockEdit) =>
    run('Saving the block', async () => {
      await writeBlock(edit);
      toast('Block saved. Cases can use it from the Record tab.', 'info');
    });

  const tryBlock = (edit: BlockEdit) =>
    run('Running the block', async () => {
      const file = !edit.file || isDirty(edit) ? await writeBlock(edit) : edit.file;
      try {
        setScreen(await api.tryBlock(edit.values ? { file, values: edit.values } : { file }));
        toast('The block ran to the end.', 'info');
      } catch (error) {
        // A failed block leaves the device where it stopped; show that screen.
        setScreen(await api.screen().catch(() => null));
        throw error;
      }
    });

  /** Records steps for the block in the form. The form stays as it is until the recording ends. */
  const recordForBlock = (edit: BlockEdit) =>
    run('Starting recording', async () => {
      const started = await api.recordBlock(edit.name.trim() || 'New block');
      setScreen(started.screen);
      setFinished(null);
      setOpenedCase(null);
      setCurrentCase(await api.currentCase());
    });

  /** Opens a saved case as a new block, not saved yet, so its details can become settings first. */
  const saveCaseAsBlock = (caseId: string) => {
    if (blockEdit && isDirty(blockEdit) && !window.confirm('Replace the block you are writing with this case?')) return;
    void run('Reading the case', async () => {
      setBlockEdit(blockFromCase(await api.caseBlockDraft(caseId)));
      setTab('blocks');
    });
  };

  const deleteBlock = (file: string, name: string) => {
    if (!window.confirm(`Delete the block "${name}" and its file?`)) return;
    void run('Deleting the block', async () => {
      await api.deleteBlock(file);
      setBlockEdit(null);
      setPickingKey(null);
      setDraft((current) => ({ ...current, blocks: current.blocks.filter((use) => use.file !== file) }));
      setProject(await api.project());
      toast('Block deleted.', 'info');
    });
  };

  /** Fills in the step waiting for a pick with what the click on the screen found. */
  const pickElement = (point: Point) =>
    run('Reading the element', async () => {
      const pick = await api.pick(point.x, point.y);
      const steps = blockEdit?.steps ?? [];
      const picked = steps.find((item) => item.key === pickingKey);
      const next = picked && pickedStep(picked, pick);
      if (!blockEdit || !next) {
        toast('Nothing with a name or id here. Click on a text or a control.');
        return;
      }
      setBlockEdit({ ...blockEdit, steps: steps.map((item) => (item === picked ? next : item)) });
      setPickingKey(null);
      if (pick.resolved?.rect) {
        setHighlight(pick.resolved.rect);
        clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
      }
    });

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

  /** The recording goes into the form, and the block stays unsaved until someone saves it. */
  const finishBlockRecording = (picks: number[]) =>
    run('Adding the steps', async () => {
      const { steps } = await api.finishBlockRecording(picks, blockEdit?.file);
      setPicking(null);
      setCurrentCase(null);
      // After a reload the form is gone, but the recording is not.
      setBlockEdit((current) => withRecordedSteps(current ?? newBlock(), steps));
      setTab('blocks');
    });

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
    const forBlock = currentCase?.forBlock === true;
    const message = forBlock
      ? 'Discard these steps? The block stays as it was.'
      : editing
        ? 'Discard these changes? The saved case stays as it was.'
        : 'Discard this case and its screenshots?';
    if (!window.confirm(message)) return;
    void run('Discarding', async () => {
      const result = await api.discardCase();
      const caseId = currentCase?.id;
      setCurrentCase(null);
      setPicking(null);
      if (forBlock) {
        setTab('blocks');
        toast('Recording discarded.', 'info');
        return;
      }
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
        evidencePack={project?.evidencePack ?? false}
        onEvidencePack={setEvidencePack}
        followPhone={followPhone}
        onFollowPhone={setFollowPhone}
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
          picking={picking !== null}
          suiteRunning={suiteRunning}
          devicesFound={devices.length > 0}
          appId={session.appId}
          onRecord={record}
          onFinish={() => void finishCase()}
          onOpenSetup={() => setSetupOpen(true)}
          expectMode={expectMode}
          waitUntilMode={waitUntilMode}
          choosing={pickingKey !== null}
          onChoose={(point) => void pickElement(point)}
          onTap={(point) => void tap(point)}
          onExpect={(point) => void expectAt(point)}
          onWaitUntil={(point) => void waitUntilAt(point)}
          onType={(text) => type(text)}
          onBack={() => void back()}
          onScroll={(direction) => void scroll(direction)}
          onRelaunch={() => void relaunch()}
          onRefresh={() => void refreshScreen()}
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
            looking={expectMode ? 'check' : waitUntilMode ? 'waitUntil' : null}
            onToggleCheck={() => {
              setWaitUntilMode(false);
              setExpectMode((current) => !current);
            }}
            onToggleWaitUntil={() => {
              setExpectMode(false);
              setWaitUntilMode((current) => !current);
            }}
            onRecord={record}
            onRunBlock={(file, values) => void runBlock(file, values)}
            onAddTestUser={addTestUser}
            liveActions={{
              changing: changingWait,
              onChanging: setChangingWait,
              onRemoveStep: (step) => void removeStep(step),
              onInsertWait: insertWait,
              onSetSeconds: (index, seconds) => void setWaitSeconds(index, seconds),
            }}
            onFinish={() => void finishCase()}
            onSavePicks={(picks) => void (currentCase?.forBlock ? finishBlockRecording(picks) : saveCase(picks))}
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
              onReference: (caseId, reference) => changeCase('Saving the reference', () => api.patchCase(caseId, { reference })),
              onDuplicate: (caseId) => changeCase('Duplicating', () => api.duplicateCase(caseId)),
              onSaveAsBlock: saveCaseAsBlock,
              onDelete: deleteCase,
              onPatchStep: (caseId, index, patch: StepPatch) => changeCase('Saving the step', () => api.patchStep(caseId, index, patch)),
              onDeleteStep: (caseId, index) => changeCase('Deleting the step', () => api.deleteStep(caseId, index)),
              onAddWait: (caseId, after) =>
                run('Adding a wait', async () => {
                  setOpenedCase(await api.addCaseWait(caseId, after, DEFAULT_WAIT_SECONDS));
                  // The edit makes earlier runs stale, which the Cases list shows.
                  setProject(await api.project());
                  return true;
                }).then((ok) => ok === true),
              onDeleteExpectation: (caseId, position) => changeCase('Deleting the check', () => api.deleteExpectation(caseId, position)),
              onSplit: (caseId, atStep) => changeCase('Splitting', () => api.splitCase(caseId, atStep)),
            }}
            blockEdit={blockEdit}
            pickingKey={pickingKey}
            blockActions={{
              onNew: () => setBlockEdit(newBlock()),
              onOpen: (file) => void openBlock(file),
              onOpenFile: openFile,
              onChange: setBlockEdit,
              onPick: setPickingKey,
              onSave: () => blockEdit && void saveBlock(blockEdit),
              onTry: () => blockEdit && void tryBlock(blockEdit),
              onRecord: () => blockEdit && void recordForBlock(blockEdit),
              onDelete: () => blockEdit?.file && deleteBlock(blockEdit.file, blockEdit.name),
              onClose: () => {
                setBlockEdit(null);
                setPickingKey(null);
              },
              onSaveValue: addSavedValue,
              onAddTestUser: addTestUser,
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
