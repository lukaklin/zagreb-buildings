"use client";

import { useRef, useState } from "react";
import { MapView, type MapHandle } from "@/components/MapView";
import { DetailsPanel } from "@/components/DetailsPanel";
import { SearchPanel } from "@/components/SearchPanel";
import { useBuildingsData } from "@/hooks/useBuildingsData";
import type { Building, BuildingFeature } from "@/lib/types";

export default function Home() {
  const { geojson, buildings } = useBuildingsData();
  const [selected, setSelected] = useState<Building | null>(null);
  const mapRef = useRef<MapHandle>(null);

  function handleSearchSelect(feature: BuildingFeature) {
    const p = feature.properties;
    mapRef.current?.flyToBuilding(p.id);
  }

  return (
    <main className="h-dvh w-dvw relative">
      <MapView ref={mapRef} geojson={geojson} onSelectBuilding={setSelected} />

      <SearchPanel buildings={buildings} onSelect={handleSearchSelect} />

      <DetailsPanel building={selected} onClose={() => setSelected(null)} />
    </main>
  );
}
