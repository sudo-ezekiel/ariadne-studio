// The Files sidebar: the project's folders as they are on disk, read only. A
// click opens a file in its own tab of the case panel. .env files never show.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileContent, FileEntry, ProjectInfo } from '../../shared/api-types.ts';
import { api } from '../api.ts';
import { ChevronIcon, CrossIcon, FileIcon, FolderIcon, RefreshIcon } from './Icons.tsx';

const STORAGE_KEY = 'ariadne-files';
const ROOT = '.';

function readFilesOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function saveFilesOpen(open: boolean): void {
  try {
    if (open) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, 'closed');
  } catch {
    // Storage can be off (private windows); the choice then lasts until reload.
  }
}

/** Whether the sidebar shows: open until the person closes it, then remembered. */
export function useFilesOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(readFilesOpen);
  const toggle = useCallback(() => {
    setOpen((current) => {
      saveFilesOpen(!current);
      return !current;
    });
  }, []);
  return [open, toggle];
}

type Props = {
  hidden: boolean;
  project: ProjectInfo | null;
  openedPath: string | undefined;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
};

export function FilesPanel({ hidden, project, openedPath, onOpenFile, onClose, onError }: Props) {
  const [roots, setRoots] = useState<FileEntry[]>([]);
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([ROOT]));
  const expandedNow = useRef(expanded);
  expandedNow.current = expanded;

  const report = useCallback((error: unknown) => onError(error instanceof Error ? error.message : String(error)), [onError]);

  const loadFolder = useCallback(async (path: string) => {
    const { entries } = await api.fileList(path);
    setChildren((current) => ({ ...current, [path]: entries }));
  }, []);

  /** Reads the roots and every open folder again. A folder that has gone just stays as it was. */
  const reload = useCallback(async () => {
    const response = await api.fileRoots();
    setRoots(response.roots);
    await Promise.all([...expandedNow.current].map((path) => loadFolder(path).catch(() => undefined)));
  }, [loadFolder]);

  // Saving a case or finishing a run changes project, and the files with it.
  useEffect(() => {
    void reload().catch(report);
  }, [project, reload, report]);

  const toggleFolder = (path: string) => {
    const next = new Set(expanded);
    if (next.delete(path)) {
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    void loadFolder(path).catch(report);
  };

  const rows = (entries: readonly FileEntry[], depth: number) => (
    <ul className="files-list">
      {entries.map((entry) => {
        const folder = entry.kind === 'folder';
        const open = expanded.has(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              className={`files-row ${entry.path === openedPath ? 'files-row-on' : ''}`}
              style={{ paddingLeft: 4 + depth * 14 }}
              title={entry.path}
              aria-expanded={folder ? open : undefined}
              onClick={() => (folder ? toggleFolder(entry.path) : onOpenFile(entry.path))}
            >
              <span className={`files-chevron ${open ? 'files-chevron-open' : ''}`}>{folder && <ChevronIcon size={12} />}</span>
              <span className="files-kind">{folder ? <FolderIcon size={14} /> : <FileIcon size={14} />}</span>
              <span className="files-name">{entry.name}</span>
            </button>
            {folder && open && rows(children[entry.path] ?? [], depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <aside className="files" aria-label="Project files" hidden={hidden}>
      <div className="files-head">
        <span className="files-title">Files</span>
        <button type="button" className="icon-button" onClick={() => void reload().catch(report)} aria-label="Refresh files" title="Refresh">
          <RefreshIcon size={14} />
        </button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Hide files" title="Hide files">
          <CrossIcon size={14} />
        </button>
      </div>
      <div className="files-tree">{rows(roots, 0)}</div>
    </aside>
  );
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file opened from the sidebar, in its tab of the case panel. */
export function FileView({ file }: { file: FileContent }) {
  return (
    <div className="file-view">
      <p className="path">{file.path} · read only</p>
      {file.kind === 'text' && file.truncated && <p className="hint">This is the start of the file; it is too long to show in full.</p>}
      {file.kind === 'text' && <pre className="yaml file-text">{file.text || 'This file is empty.'}</pre>}
      {file.kind === 'image' && <img className="file-image" src={file.url} alt={file.name} />}
      {file.kind === 'other' && <p className="hint">This file cannot be shown here ({sizeLabel(file.size)}).</p>}
    </div>
  );
}
