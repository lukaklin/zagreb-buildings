"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MapView, type MapHandle } from "@/components/MapView";
import { DetailsPanel } from "@/components/DetailsPanel";
import { SearchFilterBar, type YearRange } from "@/components/SearchFilterBar";
import { useBuildingsData } from "@/hooks/useBuildingsData";
import type { Building, BuildingFeature } from "@/lib/types";

function parseYear(value: string | null | undefined): number | null {
  if (value == null || value === "Unknown") return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

export default function Home() {
  const { geojson, buildings } = useBuildingsData();
  const [selected, setSelected] = useState<Building | null>(null);
  const [architectFilter, setArchitectFilter] = useState<Set<string>>(
    () => new Set(),
  );
  const [yearRange, setYearRange] = useState<YearRange>([1800, 2026]);
  const mapRef = useRef<MapHandle>(null);

  const visibleBuildings = useMemo(() => {
    return buildings.filter((f) => {
      const matchesArchitect =
        architectFilter.size === 0 ||
        f.properties.architects?.some((a) => architectFilter.has(a));

      const year = parseYear(f.properties.builtYear);
      const matchesYear =
        year === null ||
        (year >= yearRange[0] && year <= yearRange[1]);

      return matchesArchitect && matchesYear;
    });
  }, [buildings, architectFilter, yearRange]);

  useEffect(() => {
    const matchingIds = visibleBuildings.map((f) => f.properties.id);

    if (matchingIds.length === 0 || matchingIds.length === buildings.length) {
      mapRef.current?.applyFilter(null);
    } else {
      mapRef.current?.applyFilter([
        "in",
        ["get", "id"],
        ["literal", matchingIds],
      ]);
    }
  }, [visibleBuildings, buildings]);

  function handleSearchSelect(feature: BuildingFeature) {
    const p = feature.properties;
    mapRef.current?.flyToBuilding(p.id);
  }

  return (
    <main className="relative h-dvh w-dvw">
      <MapView ref={mapRef} geojson={geojson} onSelectBuilding={setSelected} />

      <SearchFilterBar
        buildings={buildings}
        visibleBuildings={visibleBuildings}
        onSelect={handleSearchSelect}
        selectedArchitects={architectFilter}
        onArchitectFilterChange={setArchitectFilter}
        yearRange={yearRange}
        onYearRangeChange={setYearRange}
      />

      <DetailsPanel building={selected} onClose={() => setSelected(null)} />
    </main>
  );
}
