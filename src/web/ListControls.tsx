// The filter bar pieces the list screens share: a name filter box, the sort select with its direction toggle.
import type { Dir } from "../shared/listView";

export function NameFilter({ value, onChange, placeholder, label }: { value: string; onChange: (q: string) => void; placeholder: string; label: string }) {
  return (
    <span class="qbox">
      <input
        class="chip qin"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // arrows and `f` belong to the box while typing
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
      />
      {value && (
        <button class="qclear" aria-label="Clear the name filter" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </span>
  );
}

export function SortControls<S extends string>({ sorts, labels, sort, dir, onSort, onDir }: {
  sorts: readonly S[]; labels: Record<S, string>; sort: S; dir: Dir; onSort: (s: S) => void; onDir: (d: Dir) => void;
}) {
  return (
    <>
      <select class="chip" aria-label="Sort" value={sort} onChange={(e) => onSort((e.target as HTMLSelectElement).value as S)}>
        {sorts.map((s) => (
          <option key={s} value={s}>
            {labels[s]}
          </option>
        ))}
      </select>
      <button class="chip" title="Reverse the order" aria-label={`Sorted ${dir === "asc" ? "ascending" : "descending"}; reverse`} onClick={() => onDir(dir === "asc" ? "desc" : "asc")}>
        {dir === "asc" ? "↑" : "↓"}
      </button>
    </>
  );
}
