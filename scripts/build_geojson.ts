import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

type CanonicalRow = {
  id: string;
  name: string;
  address: string;
  description: string;
  architects: string;
  source_url: string;
};

type GeometryPick = {
  osm_ref: string; // e.g. "way/123456" or "relation/789"
  geometry: GeoJSON.Geometry;
};

const CANONICAL_CSV = path.join("input", "canonical", "buildings_geocoded.csv");
const GEOMS_PATH = path.join("output", "geometries.json");
const OUT_GEOJSON = path.join("public", "data", "buildings.geojson");
const QA_REPORT = path.join("output", "qa_report.json");

function splitArchitects(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function main() {
  // --- read canonical CSV ---
  const csvText = await fs.readFile(CANONICAL_CSV, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CanonicalRow[];

  // --- read geometries ---
  const geomMap = JSON.parse(
    await fs.readFile(GEOMS_PATH, "utf8")
  ) as Record<string, GeometryPick>;

  const features: GeoJSON.Feature[] = [];
  const missingGeometry: string[] = [];

  for (const r of rows) {
    const pick = geomMap[r.id];

    if (!pick || !pick.geometry) {
      missingGeometry.push(r.id);
      continue;
    }

    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        id: r.id,
        name: r.name,
        address: r.address,
        description: r.description,
        architects: splitArchitects(r.architects),
        sourceUrl: r.source_url,
        osmRef: pick.osm_ref || undefined, // debugging helper
      },
      geometry: pick.geometry,
    });
  }

  const geojson: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features,
  };

  // --- ensure dirs ---
  await fs.mkdir(path.dirname(OUT_GEOJSON), { recursive: true });
  await fs.mkdir(path.dirname(QA_REPORT), { recursive: true });

  // --- write outputs ---
  await fs.writeFile(OUT_GEOJSON, JSON.stringify(geojson, null, 2), "utf8");

  const qa = {
    total_rows: rows.length,
    features_written: features.length,
    missing_geometry: missingGeometry,
  };

  await fs.writeFile(QA_REPORT, JSON.stringify(qa, null, 2), "utf8");

  console.log(`✅ Wrote ${OUT_GEOJSON}`);
  console.log(`✅ Wrote ${QA_REPORT}`);
  console.log(
    `Features: ${features.length}/${rows.length} ${
      missingGeometry.length ? `(missing: ${missingGeometry.length})` : ""
    }`
  );
}

main().catch((err) => {
  console.error("❌ build_geojson failed:", err);
  process.exit(1);
});
