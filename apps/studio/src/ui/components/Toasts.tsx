/** A message in the corner. `action` is a button beside it, such as Undo; pressing it also dismisses the toast. */
export type Toast = { id: number; message: string; kind: 'error' | 'info'; action?: { label: string; run: () => void } };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                onDismiss(toast.id);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
