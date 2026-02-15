"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BuildingFeature } from "@/lib/types";
import { searchBuildings, normalizeText } from "@/lib/search";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";
import { Label } from "./ui/label";
import { Slider } from "./ui/slider";
import { Checkbox } from "./ui/checkbox";
import { Badge } from "./ui/badge";

export type YearRange = [number, number];

const ARCHITECT_LIMIT = 10;

type Props = {
  buildings: BuildingFeature[];
  visibleBuildings: BuildingFeature[];
  onSelect: (feature: BuildingFeature) => void;
  selectedArchitects: Set<string>;
  onArchitectFilterChange: (next: Set<string>) => void;
  yearRange: YearRange;
  onYearRangeChange: (range: YearRange) => void;
};

export function SearchFilterBar({
  buildings,
  visibleBuildings,
  onSelect,
  selectedArchitects,
  onArchitectFilterChange,
  yearRange,
  onYearRangeChange,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BuildingFeature[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [localArchitects, setLocalArchitects] = useState<Set<string>>(
    () => new Set(selectedArchitects),
  );
  const [localYearRange, setLocalYearRange] = useState<YearRange>(yearRange);
  const [architectQuery, setArchitectQuery] = useState("");
  const [architectsExpanded, setArchitectsExpanded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local filter state when popover opens
  useEffect(() => {
    if (filterOpen) {
      setLocalArchitects(new Set(selectedArchitects));
      setLocalYearRange(yearRange);
      setArchitectsExpanded(false);
    }
  }, [filterOpen, selectedArchitects, yearRange]);

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

  const displayedArchitects = architectsExpanded
    ? filteredArchitects
    : filteredArchitects.slice(0, ARCHITECT_LIMIT);

  const updateResults = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const r = searchBuildings(visibleBuildings, q);
        setResults(r);
        setActiveIdx(-1);
        setOpen(r.length > 0 && q.trim().length > 0);
      }, 150);
    },
    [visibleBuildings],
  );

  function handleSearchChange(value: string) {
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

  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

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

  function handleArchitectToggle(name: string) {
    setLocalArchitects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function applyFilters() {
    onArchitectFilterChange(localArchitects);
    onYearRangeChange(localYearRange);
    setFilterOpen(false);
  }

  function clearFilters() {
    setLocalArchitects(new Set());
    setLocalYearRange([1800, 2026]);
    onArchitectFilterChange(new Set());
    onYearRangeChange([1800, 2026]);
  }

  const activeFilterCount =
    selectedArchitects.size +
    (yearRange[0] !== 1800 || yearRange[1] !== 2026 ? 1 : 0);

  return (
    <div className="absolute top-4 left-4 z-[1000] flex gap-2">
      <div className="relative w-80">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-500" />
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={() => {
            if (results.length > 0 && query.trim()) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search buildings..."
          className="w-full border-gray-200 bg-white pl-10 shadow-lg"
        />

        {open && results.length > 0 && (
          <ul
            ref={listRef}
            className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-white shadow-lg"
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
                    cursor-pointer border-b border-border px-4 py-2.5 text-sm last:border-b-0
                    ${i === activeIdx ? "bg-blue-50" : "hover:bg-gray-50"}
                  `}
                >
                  <div className="truncate font-medium text-gray-900">
                    {p.name || p.address || "Unknown"}
                  </div>
                  {p.address && p.name && (
                    <div className="mt-0.5 truncate text-xs text-gray-500">
                      {p.address}
                    </div>
                  )}
                  {p.architects && p.architects.length > 0 && (
                    <div className="mt-0.5 truncate text-xs text-gray-400">
                      {p.architects.join(", ")}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="relative bg-white shadow-lg"
          >
            <SlidersHorizontal className="size-4 mr-2" />
            Filters
            {activeFilterCount > 0 && (
              <Badge className="ml-2 flex h-5 min-w-5 items-center justify-center px-1.5">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-80 max-h-[500px] overflow-y-auto"
          align="start"
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Filters</h4>
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear all
              </Button>
            </div>

            <div className="space-y-3">
              <Label>Year Built</Label>
              <div className="space-y-2">
                <Slider
                  min={1800}
                  max={2026}
                  step={1}
                  value={localYearRange}
                  onValueChange={(v) =>
                    setLocalYearRange([v[0], v[1]] as YearRange)
                  }
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-600">
                  <span>{localYearRange[0]}</span>
                  <span>{localYearRange[1]}</span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Architect</Label>
              <Input
                type="text"
                value={architectQuery}
                onChange={(e) => setArchitectQuery(e.target.value)}
                placeholder="Search architects..."
                className="h-8 text-sm"
              />
              <div className="space-y-2">
                {displayedArchitects.map(({ name, count }) => (
                  <div
                    key={name}
                    className="flex items-center space-x-2"
                  >
                    <Checkbox
                      id={`architect-${name}`}
                      checked={localArchitects.has(name)}
                      onCheckedChange={() => handleArchitectToggle(name)}
                    />
                    <label
                      htmlFor={`architect-${name}`}
                      className="cursor-pointer text-sm"
                    >
                      {name}
                      <span className="ml-1.5 text-gray-400">({count})</span>
                    </label>
                  </div>
                ))}
                {filteredArchitects.length === 0 && (
                  <p className="py-2 text-center text-sm text-gray-500">
                    No architects match
                  </p>
                )}
                {filteredArchitects.length > ARCHITECT_LIMIT && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-sm"
                    onClick={() => setArchitectsExpanded((e) => !e)}
                  >
                    {architectsExpanded ? "See less" : "See more"}
                  </Button>
                )}
              </div>
            </div>

            <Button onClick={applyFilters} className="w-full">
              Apply Filters
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
