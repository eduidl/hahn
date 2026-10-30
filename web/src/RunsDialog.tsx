import { useEffect, useRef, useState } from "react";
import { get } from "./sources";
import { errorMessage, type RunList } from "./types";

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
    <dialog ref={dialog} className="runs-dialog" aria-label="走行を選択" onClose={onClose}>
      <h2>走行を選択</h2>
      <input
        className="search"
        role="combobox"
        aria-expanded="true"
        aria-controls="runs-list"
        aria-activedescendant={items[active] && `run-option-${active}`}
        aria-label="走行を検索"
        placeholder="走行を検索…"
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
          ? `上位 ${items.length} 件を表示中。検索で絞り込んでください`
          : list && `${items.length} 件`}
      </div>
      {error && <p role="alert">{error}</p>}
      <ul ref={listRef} id="runs-list" className="runs-list" role="listbox" aria-label="走行">
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
      {list && !items.length && <p className="muted">該当する走行がありません</p>}
      <button className="runs-close" onClick={onClose}>
        閉じる
      </button>
    </dialog>
  );
}
