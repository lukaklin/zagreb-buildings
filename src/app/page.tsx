"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MapView, type MapHandle } from "@/components/MapView";
import { DetailsPanel } from "@/components/DetailsPanel";
import { SearchPanel } from "@/components/SearchPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { useBuildingsData } from "@/hooks/useBuildingsData";
import type { Building, BuildingFeature } from "@/lib/types";

export default function Home() {
  const { geojson, buildings } = useBuildingsData();
  const [selected, setSelected] = useState<Building | null>(null);
  const [architectFilter, setArchitectFilter] = useState<Set<string>>(
    () => new Set(),
  );
  const mapRef = useRef<MapHandle>(null);

  const visibleBuildings = useMemo(() => {
    if (architectFilter.size === 0) return buildings;
    return buildings.filter((f) =>
      f.properties.architects?.some((a) => architectFilter.has(a)),
    );
  }, [buildings, architectFilter]);

  useEffect(() => {
    if (architectFilter.size === 0) {
      mapRef.current?.applyFilter(null);
    } else {
      const matchingIds = buildings
        .filter((f) =>
          f.properties.architects?.some((a) => architectFilter.has(a)),
        )
        .map((f) => f.properties.id);
      mapRef.current?.applyFilter([
        "in",
        ["get", "id"],
        ["literal", matchingIds],
      ]);
    }
  }, [architectFilter, buildings]);

  function handleSearchSelect(feature: BuildingFeature) {
    const p = feature.properties;
    mapRef.current?.flyToBuilding(p.id);
  }

  return (
    <main className="h-dvh w-dvw relative">
      <MapView ref={mapRef} geojson={geojson} onSelectBuilding={setSelected} />

      <SearchPanel
        buildings={visibleBuildings}
        onSelect={handleSearchSelect}
        filterSlot={
          <FilterPanel
            buildings={buildings}
            selected={architectFilter}
            onChangeSelected={setArchitectFilter}
          />
        }
      />

      <DetailsPanel building={selected} onClose={() => setSelected(null)} />
    </main>
  );
}
