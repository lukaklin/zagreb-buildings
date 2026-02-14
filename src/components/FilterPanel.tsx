"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { BuildingFeature } from "@/lib/types";
import { normalizeText } from "@/lib/search";

type Props = {
  buildings: BuildingFeature[];
  selected: Set<string>;
  onChangeSelected: (next: Set<string>) => void;
};

export function FilterPanel({
  buildings,
  selected,
  onChangeSelected,
}: Props) {
  const [open, setOpen] = useState(false);
  const [architectQuery, setArchitectQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const architectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of buildings) {
      f.properties.architects?.forEach((a) => {
        counts.set(a, (counts.get(a) ?? 0) + 1);
      });
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [buildings]);

  const filteredArchitects = useMemo(() => {
    const q = architectQuery.trim();
    if (!q) return architectCounts;
    const nq = normalizeText(q);
    return architectCounts.filter(({ name }) =>
      normalizeText(name).includes(nq),
    );
  }, [architectCounts, architectQuery]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggleArchitect(name: string) {
    const next = new Set(selected);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    onChangeSelected(next);
  }

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="
          rounded-xl border bg-white/90 backdrop-blur px-3 py-2.5 text-sm
          font-medium text-gray-700 shadow-sm hover:bg-gray-50
          focus:outline-none focus:ring-2 focus:ring-blue-400
        "
      >
        Filter
        {selected.size > 0 && (
          <span className="ml-1.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
            {selected.size}
          </span>
        )}
        <span className="ml-1 text-gray-400">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div
          className="
            absolute left-0 top-full z-20 mt-1 w-72 rounded-xl border
            bg-white/95 shadow-lg backdrop-blur
          "
        >
          <div className="border-b p-2">
            <input
              type="text"
              value={architectQuery}
              onChange={(e) => setArchitectQuery(e.target.value)}
              placeholder="Search architects..."
              className="
                w-full rounded-lg border px-3 py-2 text-sm
                placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400
              "
            />
          </div>

          <ul
            className="max-h-72 overflow-auto p-2"
            role="listbox"
          >
            {filteredArchitects.map(({ name, count }) => (
              <li key={name} className="flex items-center gap-2 py-1.5">
                <input
                  type="checkbox"
                  id={`arch-${name}`}
                  checked={selected.has(name)}
                  onChange={() => toggleArchitect(name)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label
                  htmlFor={`arch-${name}`}
                  className="flex-1 cursor-pointer text-sm text-gray-900"
                >
                  {name}
                  <span className="ml-1.5 text-gray-400">({count})</span>
                </label>
              </li>
            ))}
            {filteredArchitects.length === 0 && (
              <li className="py-4 text-center text-sm text-gray-500">
                No architects match
              </li>
            )}
          </ul>

          {selected.size > 0 && (
            <div className="border-t p-2">
              <button
                type="button"
                onClick={() => onChangeSelected(new Set())}
                className="text-sm text-gray-600 underline hover:text-gray-900"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
