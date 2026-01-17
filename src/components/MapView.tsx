"use client";

import maplibregl, { Map, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Building } from "@/lib/types";

type Props = {
  onSelectBuilding: (b: Building | null) => void;
};

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
      const res = await fetch("/data/buildings.geojson");
      const geojson = await res.json();

      map.addSource("buildings", {
        type: "geojson",
        data: geojson,
        promoteId: "id", // use properties.id as the feature id for feature-state
      });

      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
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

      // Hover highlight
      map.on("mousemove", "buildings-fill", (e) => {
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
          architects: p.architects
            ? Array.isArray(p.architects)
              ? p.architects
              : [String(p.architects)]
            : null,
          sourceUrl: p.sourceUrl ? String(p.sourceUrl) : null,
        };
      
        onSelectBuilding(b);
      });      

      // Click empty space clears selection
      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["buildings-fill"],
        });
        if (features.length === 0) {
          setSelected(map, null);
          onSelectBuilding(null);
        }
      });
    });

    mapRef.current = map;

        // DEBUG: log rendered features on click
    map.on("click", (e) => {
      const features = map.queryRenderedFeatures(e.point);

      console.log(
        "Rendered features under click:",
        features.map((f) => ({
          layer: f.layer.id,
          id: f.id,
          properties: f.properties,
        }))
      );
    });


    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onSelectBuilding]);

  return <div ref={containerRef} className="h-full w-full" />;
}
