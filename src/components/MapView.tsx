"use client";

import maplibregl, { Map } from "maplibre-gl";
import { useEffect, useRef } from "react";

type Props = { onClickMap: () => void };

export function MapView({ onClickMap }: Props) {
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
    map.on("click", onClickMap);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onClickMap]);

  return <div ref={containerRef} className="h-full w-full" />;
}
