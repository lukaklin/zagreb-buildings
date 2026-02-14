"use client";

import { useEffect, useState } from "react";
import type { BuildingFeature } from "@/lib/types";

export function useBuildingsData() {
  const [geojson, setGeojson] =
    useState<GeoJSON.FeatureCollection | null>(null);
  const [buildings, setBuildings] = useState<BuildingFeature[]>([]);

  useEffect(() => {
    fetch("/data/buildings_combined.geojson")
      .then((r) => r.json())
      .then((data: GeoJSON.FeatureCollection) => {
        setGeojson(data);
        setBuildings(data.features as BuildingFeature[]);
      });
  }, []);

  return { geojson, buildings };
}
