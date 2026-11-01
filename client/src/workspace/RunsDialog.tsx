import "./RunsDialog.css";
import { useEffect, useRef, useState } from "react";
import { get } from "../data/sources";
import { errorMessage, type RunList } from "../types";

const LIMIT = 50;
const SEARCH_DELAY_MS = 200;

/** Picks the run to view. A server may have many, so it searches on the server. */
export function RunsDialog({
  open,
  current,
  onSelect,
  onClose,
}: {
  open: boolean;
  current: string | null;
  onSelect: (run: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<RunList | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim();

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(LIMIT) });
    if (q) params.set("q", q);
    const timer = setTimeout(() => {
      get<RunList>(`/api/runs?${params}`, controller.signal)
        .then((result) => {
          setList(result);
          setActive(0);
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(errorMessage(e));
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, q]);

  const items = list?.items ?? [];

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const move = (step: number) => {
    if (items.length) setActive((active + step + items.length) % items.length);
  };
  return (
    <dialog
      ref={dialog}
      className="dialog-surface runs-dialog"
      aria-label="Select run"
      onClose={onClose}
    >
      <h2>Select run</h2>
      <input
        className="text-input search"
        role="combobox"
        aria-expanded="true"
        aria-controls="runs-list"
        aria-activedescendant={items[active] && `run-option-${active}`}
        aria-label="Search runs"
        placeholder="Search runs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter" && items[active]) {
            onSelect(items[active].id);
          }
        }}
      />
      <div className="runs-count">
        {list?.truncated
          ? `Showing ${items.length} results. Refine your search.`
          : list && `${items.length} runs`}
      </div>
      {error && <p role="alert">{error}</p>}
      <ul ref={listRef} id="runs-list" className="runs-list" role="listbox" aria-label="Runs">
        {items.map((run, i) => (
          <li
            key={run.id}
            id={`run-option-${i}`}
            role="option"
            aria-selected={i === active}
            aria-current={run.id === current || undefined}
            onMouseMove={() => setActive(i)}
            onClick={() => onSelect(run.id)}
          >
            {run.name}
          </li>
        ))}
      </ul>
      {list && !items.length && <p className="muted">No matching runs</p>}
      <button className="runs-close" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
