"use client";

import { useState } from "react";
import { MapView } from "@/components/MapView";
import { DetailsPanel } from "@/components/DetailsPanel";
import type { Building } from "@/lib/types";

export default function Home() {
  const [selected, setSelected] = useState<Building | null>(null);

  return (
    <main className="h-dvh w-dvw relative">
      <MapView onSelectBuilding={setSelected} />

      <div className="absolute top-3 left-3 z-10 bg-white/90 backdrop-blur border rounded-2xl px-3 py-2 shadow-sm">
        <div className="text-sm font-semibold">Zagreb Buildings</div>
        <div className="text-xs text-gray-600">Click a polygon → open details</div>
      </div>

      <DetailsPanel building={selected} onClose={() => setSelected(null)} />
    </main>
  );
}
