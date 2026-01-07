"use client";

import maplibregl, { Map, MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Building } from "@/lib/types";

type Props = {
  onSelectBuilding: (b: Building | null) => void;
};

export function MapView({ onSelectBuilding }: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return;

    const style: maplibregl.StyleSpecification = {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [15.97798, 45.81318],
      zoom: 15,
      maxZoom: 19,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-left");

    map.on("load", async () => {
      // Load GeoJSON from public/
      const res = await fetch("/data/buildings.geojson");
      const geojson = await res.json();

      map.addSource("buildings", {
        type: "geojson",
        data: geojson,
      });

      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        paint: {
          "fill-opacity": 0.35
        },
      });

      map.addLayer({
        id: "buildings-outline",
        type: "line",
        source: "buildings",
        paint: {
          "line-width": 2
        },
      });

      // Cursor feedback
      map.on("mouseenter", "buildings-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "buildings-fill", () => {
        map.getCanvas().style.cursor = "";
      });

      // Click selection: only if user clicked a building polygon
      map.on("click", "buildings-fill", (e: MapMouseEvent) => {
        const f = e.features?.[0];
        const p = (f?.properties ?? {}) as any;

        // Properties from GeoJSON come as strings sometimes; we keep it simple for now
        const b: Building = {
          id: String(p.id ?? f?.id ?? ""),
          name: p.name ? String(p.name) : null,
          address: p.address ? String(p.address) : null,
          description: p.description ? String(p.description) : null,
          architects: p.architects
            ? // if it's already an array, great; if it's a string, wrap it
              (Array.isArray(p.architects) ? p.architects : [String(p.architects)])
            : null,
          sourceUrl: p.sourceUrl ? String(p.sourceUrl) : null,
        };

        onSelectBuilding(b);
      });

      // Click empty space clears selection
      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["buildings-fill"] });
        if (features.length === 0) onSelectBuilding(null);
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onSelectBuilding]);

  return <div ref={containerRef} className="h-full w-full" />;
}
