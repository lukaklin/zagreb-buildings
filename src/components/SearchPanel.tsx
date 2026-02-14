"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildingFeature } from "@/lib/types";
import { searchBuildings } from "@/lib/search";

type Props = {
  buildings: BuildingFeature[];
  onSelect: (feature: BuildingFeature) => void;
};

export function SearchPanel({ buildings, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BuildingFeature[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [open, setOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search
  const updateResults = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const r = searchBuildings(buildings, q);
        setResults(r);
        setActiveIdx(-1);
        setOpen(r.length > 0 && q.trim().length > 0);
      }, 150);
    },
    [buildings],
  );

  function handleChange(value: string) {
    setQuery(value);
    updateResults(value);
  }

  function selectResult(feature: BuildingFeature) {
    setQuery("");
    setResults([]);
    setOpen(false);
    onSelect(feature);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < results.length) {
          selectResult(results[activeIdx]);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        inputRef.current?.blur();
        break;
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !inputRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="absolute top-3 left-3 z-10 w-72 sm:w-80">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => {
            if (results.length > 0 && query.trim()) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search buildings..."
          className="
            w-full rounded-2xl border bg-white/90 backdrop-blur
            px-4 py-2.5 text-sm text-gray-900 shadow-sm
            placeholder:text-gray-400
            focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent
          "
        />

        {/* Magnifying glass icon */}
        <svg
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {open && results.length > 0 && (
        <ul
          ref={listRef}
          className="
            mt-1 max-h-72 overflow-auto rounded-xl border bg-white/95
            backdrop-blur shadow-lg
          "
          role="listbox"
        >
          {results.map((f, i) => {
            const p = f.properties;
            return (
              <li
                key={p.id}
                role="option"
                aria-selected={i === activeIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => selectResult(f)}
                className={`
                  cursor-pointer px-4 py-2.5 text-sm border-b last:border-b-0
                  ${i === activeIdx ? "bg-blue-50" : "hover:bg-gray-50"}
                `}
              >
                <div className="font-medium text-gray-900 truncate">
                  {p.name || p.address || "Unknown"}
                </div>
                {p.address && p.name && (
                  <div className="text-xs text-gray-500 truncate mt-0.5">
                    {p.address}
                  </div>
                )}
                {p.architects && p.architects.length > 0 && (
                  <div className="text-xs text-gray-400 truncate mt-0.5">
                    {p.architects.join(", ")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
