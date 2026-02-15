"use client";

import maplibregl, { Map, MapLayerMouseEvent } from "maplibre-gl";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useCallback,
} from "react";
import type { Building } from "@/lib/types";

export type MapHandle = {
  /** Fly to a building by its feature id and visually select it. */
  flyToBuilding: (featureId: string) => void;
  /** Apply a MapLibre filter to building layers (null = show all). */
  applyFilter: (filter: maplibregl.FilterSpecification | null) => void;
};

type Props = {
  geojson: GeoJSON.FeatureCollection | null;
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

  const items: string[] = Array.isArray(raw)
    ? raw.flatMap(expandOne)
    : expandOne(raw);

  const cleaned = items
    .map(cleanToken)
    .filter(Boolean)
    // dedupe case-insensitive
    .filter(
      (v, i, arr) =>
        arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i,
    );

  return cleaned.length ? cleaned : null;
}

function buildingFromProps(p: Record<string, any>): Building {
  return {
    id: String(p.id ?? ""),
    name: p.name ? String(p.name) : null,
    address: p.address ? String(p.address) : null,
    addressRaw: p.addressRaw ? String(p.addressRaw) : null,
    description: p.description ? String(p.description) : null,
    architects: parseArchitects(p.architects),
    sourceUrl: p.sourceUrl ? String(p.sourceUrl) : null,
    imageThumbUrl: p.imageThumbUrl ? String(p.imageThumbUrl) : null,
    imageFullUrl: p.imageFullUrl ? String(p.imageFullUrl) : null,
    builtYear: p.builtYear ? String(p.builtYear) : "Unknown",
  };
}

export const MapView = forwardRef<MapHandle, Props>(function MapView(
  { geojson, onSelectBuilding },
  ref,
) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const hoveredIdRef = useRef<string | number | null>(null);
  const selectedIdRef = useRef<string | number | null>(null);

  // Track whether the source + layers have been added already
  const sourceAddedRef = useRef(false);

  // Keep latest onSelectBuilding in a ref so the map callbacks don't go stale
  const onSelectRef = useRef(onSelectBuilding);
  onSelectRef.current = onSelectBuilding;

  // Keep latest geojson in a ref for flyToBuilding lookups
  const geojsonRef = useRef(geojson);
  geojsonRef.current = geojson;

  // Store current user filter so it can be applied when layers are added
  const filterRef = useRef<maplibregl.FilterSpecification | null>(null);

  function setHover(map: maplibregl.Map, id: string | number | null) {
    if (hoveredIdRef.current !== null) {
      map.setFeatureState(
        { source: "buildings", id: hoveredIdRef.current },
        { hover: false },
      );
    }
    hoveredIdRef.current = id;
    if (id !== null) {
      map.setFeatureState({ source: "buildings", id }, { hover: true });
    }
  }

  const setSelected = useCallback(
    (map: maplibregl.Map, id: string | number | null) => {
      if (selectedIdRef.current !== null) {
        map.setFeatureState(
          { source: "buildings", id: selectedIdRef.current },
          { selected: false },
        );
      }
      selectedIdRef.current = id;
      if (id !== null) {
        map.setFeatureState({ source: "buildings", id }, { selected: true });
      }
    },
    [],
  );

  // Apply user filter to building layers (merge with geometry-type base filter)
  const applyFilterToMap = useCallback(
    (map: maplibregl.Map, userFilter: maplibregl.FilterSpecification | null) => {
      const polyBase: maplibregl.FilterSpecification = [
        "!=",
        ["geometry-type"],
        "Point",
      ];
      const pointBase: maplibregl.FilterSpecification = [
        "==",
        ["geometry-type"],
        "Point",
      ];
      const polyFilter: maplibregl.FilterSpecification = userFilter
        ? (["all", polyBase, userFilter] as maplibregl.FilterSpecification)
        : polyBase;
      const pointFilter: maplibregl.FilterSpecification = userFilter
        ? (["all", pointBase, userFilter] as maplibregl.FilterSpecification)
        : pointBase;

      if (map.getLayer("buildings-fill")) {
        map.setFilter("buildings-fill", polyFilter);
        map.setFilter("buildings-outline", polyFilter);
        map.setFilter("buildings-points", pointFilter);
      }
    },
    [],
  );

  // Expose imperative handle
  useImperativeHandle(
    ref,
    () => ({
      flyToBuilding(featureId: string) {
        const map = mapRef.current;
        if (!map) return;

        setSelected(map, featureId);

        // Find the feature from the geojson data
        const feature = geojsonRef.current?.features.find(
          (f) => f.properties?.id === featureId,
        );
        if (!feature) return;

        const geom = feature.geometry;

        if (geom.type === "Point") {
          const [lng, lat] = geom.coordinates as [number, number];
          map.flyTo({ center: [lng, lat], zoom: 17, duration: 1200 });
        } else {
          // Compute bounding box from coordinates
          const coords = getAllCoordinates(geom);
          if (coords.length === 0) return;

          const bounds = coords.reduce(
            (b, [lng, lat]) => {
              b[0][0] = Math.min(b[0][0], lng);
              b[0][1] = Math.min(b[0][1], lat);
              b[1][0] = Math.max(b[1][0], lng);
              b[1][1] = Math.max(b[1][1], lat);
              return b;
            },
            [
              [Infinity, Infinity],
              [-Infinity, -Infinity],
            ] as [[number, number], [number, number]],
          );

          map.fitBounds(bounds, {
            padding: 120,
            maxZoom: 18,
            duration: 1200,
          });
        }

        // Also fire the selection callback
        onSelectRef.current(buildingFromProps(feature.properties ?? {}));
      },
      applyFilter(userFilter: maplibregl.FilterSpecification | null) {
        filterRef.current = userFilter;
        const map = mapRef.current;
        if (map) applyFilterToMap(map, userFilter);
      },
    }),
    [setSelected, applyFilterToMap],
  );

  // ---- Initialise the map (once) ----
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

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      sourceAddedRef.current = false;
    };
  }, []);

  // ---- Add / update the GeoJSON source when data arrives ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !geojson) return;

    function addSourceAndLayers() {
      if (!map || sourceAddedRef.current) return;

      map.addSource("buildings", {
        type: "geojson",
        data: geojson!,
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

      // Click selection
      map.on("click", "buildings-fill", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const p = (f?.properties ?? {}) as any;
        const id = p.id ?? null;
        setSelected(map, id);
        onSelectRef.current(buildingFromProps(p));
      });

      map.on("click", "buildings-points", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const p = (f?.properties ?? {}) as any;
        const id = p.id ?? null;
        setSelected(map, id);
        onSelectRef.current(buildingFromProps(p));
      });

      // Click empty space clears selection
      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["buildings-fill", "buildings-points"],
        });
        if (features.length === 0) {
          setSelected(map, null);
          onSelectRef.current(null);
        }
      });

      sourceAddedRef.current = true;

      // Apply any filter that was set before layers were ready
      if (filterRef.current !== null) {
        applyFilterToMap(map, filterRef.current);
      }
    }

    // Map may or may not have finished loading yet
    if (map.isStyleLoaded()) {
      addSourceAndLayers();
    } else {
      map.on("load", addSourceAndLayers);
    }
  }, [geojson, setSelected]);

  return <div ref={containerRef} className="h-full w-full" />;
});

/** Recursively extract all [lng, lat] coordinate pairs from a geometry. */
function getAllCoordinates(geom: GeoJSON.Geometry): number[][] {
  switch (geom.type) {
    case "Point":
      return [geom.coordinates];
    case "MultiPoint":
    case "LineString":
      return geom.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geom.coordinates.flat();
    case "MultiPolygon":
      return geom.coordinates.flat(2);
    case "GeometryCollection":
      return geom.geometries.flatMap(getAllCoordinates);
    default:
      return [];
  }
}
