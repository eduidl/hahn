import "./ConfirmDialog.css";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/** Asks before an action that cannot be undone. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      // The safe choice takes the initial focus, so Enter cannot discard by accident.
      cancel.current?.focus();
    } else if (dialog.current?.open) {
      dialog.current.close();
    }
  }, [open]);

  // In body so that the opener's container styles do not apply to the dialog.
  return createPortal(
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onClose={onClose}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-message`}>{message}</p>
      <div className="confirm-actions">
        <button ref={cancel} onClick={onClose}>
          Cancel
        </button>
        <button className="danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
