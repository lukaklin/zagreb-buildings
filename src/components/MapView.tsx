"use client";

import maplibregl, { Map, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Building } from "@/lib/types";

type Props = {
  onSelectBuilding: (b: Building | null) => void;
};

function parseArchitects(raw: any): string[] | null {
  if (raw == null) return null;

  const cleanToken = (t: string) =>
    t
      .replace(/^Arhitekti\s*;?\s*/i, "")
      .replace(/^\s*\[|\]\s*$/g, "")
      .replace(/"/g, "")
      .trim();

  const expandOne = (v: any): string[] => {
    if (v == null) return [];
    const s = String(v).trim();
    if (!s) return [];

    // If element is itself a JSON array string like '["A","B"]'
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr.map(String);
      } catch {
        // fall through
      }
    }

    // Otherwise split by ; or ,
    return s.split(/[;,]/g).map((x) => x.trim());
  };

  const items: string[] = Array.isArray(raw) ? raw.flatMap(expandOne) : expandOne(raw);

  const cleaned = items
    .map(cleanToken)
    .filter(Boolean)
    // dedupe case-insensitive
    .filter((v, i, arr) => arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);

  return cleaned.length ? cleaned : null;
}

export function MapView({ onSelectBuilding }: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const hoveredIdRef = useRef<string | number | null>(null);
  const selectedIdRef = useRef<string | number | null>(null);

  function setHover(map: maplibregl.Map, id: string | number | null) {
    if (hoveredIdRef.current !== null) {
      map.setFeatureState(
        { source: "buildings", id: hoveredIdRef.current },
        { hover: false }
      );
    }
    hoveredIdRef.current = id;
    if (id !== null) {
      map.setFeatureState({ source: "buildings", id }, { hover: true });
    }
  }

  function setSelected(map: maplibregl.Map, id: string | number | null) {
    if (selectedIdRef.current !== null) {
      map.setFeatureState(
        { source: "buildings", id: selectedIdRef.current },
        { selected: false }
      );
    }
    selectedIdRef.current = id;
    if (id !== null) {
      map.setFeatureState({ source: "buildings", id }, { selected: true });
    }
  }

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
      const res = await fetch("/data/buildings_combined.geojson");
      const geojson = await res.json();

      map.addSource("buildings", {
        type: "geojson",
        data: geojson,
        promoteId: "id",
      });

      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        filter: ["!=", ["geometry-type"], "Point"],
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#2563eb",
            ["boolean", ["feature-state", "hover"], false],
            "#60a5fa",
            "#93c5fd",
          ],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.55,
            ["boolean", ["feature-state", "hover"], false],
            0.45,
            0.25,
          ],
        },
      });

      map.addLayer({
        id: "buildings-outline",
        type: "line",
        source: "buildings",
        filter: ["!=", ["geometry-type"], "Point"],
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#1d4ed8",
            ["boolean", ["feature-state", "hover"], false],
            "#2563eb",
            "#1e3a8a",
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            4,
            ["boolean", ["feature-state", "hover"], false],
            3,
            1.5,
          ],
          "line-opacity": 0.9,
        },
      });

      map.addLayer({
        id: "buildings-points",
        type: "circle",
        source: "buildings",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            10,
            ["boolean", ["feature-state", "hover"], false],
            8,
            6,
          ],
          "circle-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#2563eb",
            ["boolean", ["feature-state", "hover"], false],
            "#60a5fa",
            "#f59e0b",
          ],
          "circle-opacity": 0.85,
          "circle-stroke-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            3,
            ["boolean", ["feature-state", "hover"], false],
            2,
            1.5,
          ],
          "circle-stroke-color": "#1e3a8a",
        },
      });

      // Hover highlight
      map.on("mousemove", "buildings-fill", (e) => {
        const f = e.features?.[0];
        const id = (f?.properties as any)?.id ?? null;
        if (id == null) return;

        map.getCanvas().style.cursor = "pointer";
        setHover(map, id);
      });

      map.on("mousemove", "buildings-points", (e) => {
        const f = e.features?.[0];
        const id = (f?.properties as any)?.id ?? null;
        if (id == null) return;

        map.getCanvas().style.cursor = "pointer";
        setHover(map, id);
      });

      map.on("mouseleave", "buildings-fill", () => {
        map.getCanvas().style.cursor = "";
        setHover(map, null);
      });

      map.on("mouseleave", "buildings-points", () => {
        map.getCanvas().style.cursor = "";
        setHover(map, null);
      });

      // Click selection (polygon only)
      map.on("click", "buildings-fill", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const p = (f?.properties ?? {}) as any;

        const id = p.id ?? null;
        setSelected(map, id);

        const b: Building = {
          id: String(p.id ?? ""),
          name: p.name ? String(p.name) : null,
          address: p.address ? String(p.address) : null,
          description: p.description ? String(p.description) : null,
          architects: parseArchitects(p.architects),
          sourceUrl: p.sourceUrl ? String(p.sourceUrl) : null,

          imageThumbUrl: p.imageThumbUrl ? String(p.imageThumbUrl) : null,
          imageFullUrl: p.imageFullUrl ? String(p.imageFullUrl) : null,
          builtYear: p.builtYear ? String(p.builtYear) : "Unknown",
        };

        onSelectBuilding(b);
      });

      map.on("click", "buildings-points", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const p = (f?.properties ?? {}) as any;

        const id = p.id ?? null;
        setSelected(map, id);

        const b: Building = {
          id: String(p.id ?? ""),
          name: p.name ? String(p.name) : null,
          address: p.address ? String(p.address) : null,
          description: p.description ? String(p.description) : null,
          architects: parseArchitects(p.architects),
          sourceUrl: p.sourceUrl ? String(p.sourceUrl) : null,

          imageThumbUrl: p.imageThumbUrl ? String(p.imageThumbUrl) : null,
          imageFullUrl: p.imageFullUrl ? String(p.imageFullUrl) : null,
          builtYear: p.builtYear ? String(p.builtYear) : "Unknown",
        };

        onSelectBuilding(b);
      });

      // Click empty space clears selection
      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["buildings-fill", "buildings-points"],
        });
        if (features.length === 0) {
          setSelected(map, null);
          onSelectBuilding(null);
        }
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
