import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { withErrorHandling } from "./validation";

type AnyRow = Record<string, string>;

function uniq(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

function toIdSet(ids: string[]) {
  return new Set(uniq(ids));
}

function diff(a: Set<string>, b: Set<string>) {
  // elements in a but not in b
  const out: string[] = [];
  for (const id of a) if (!b.has(id)) out.push(id);
  out.sort();
  return out;
}

async function readCsvRows(p: string): Promise<AnyRow[]> {
  const txt = await fs.readFile(p, "utf8");
  return parse(txt, { columns: true, skip_empty_lines: true, trim: true }) as AnyRow[];
}

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

function indexById(rows: AnyRow[]) {
  const m: Record<string, AnyRow> = {};
  for (const r of rows) {
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    m[id] = r;
  }
  return m;
}

async function main() {
  const AREA_SLUG = process.argv[2] || "combined";

  const CANONICAL = path.join("input", "canonical", `buildings_${AREA_SLUG}_canonical.csv`);
  const GEOCODED = path.join("input", "canonical", `buildings_${AREA_SLUG}_geocoded.csv`);
  const FOOTPRINT_RESULTS = path.join("output", `footprint_results_${AREA_SLUG}.json`);
  const GEOMETRIES = path.join("output", `geometries_${AREA_SLUG}.json`);
  const GEOJSON = path.join("public", "data", `buildings_${AREA_SLUG}.geojson`);
  const OUT = path.join("output", `pipeline_summary_${AREA_SLUG}.json`);

  const result = await withErrorHandling(async () => {
    const canonicalRows = await readCsvRows(CANONICAL);
    const geocodedRows = await readCsvRows(GEOCODED);

    const canonicalIds = toIdSet(canonicalRows.map((r) => String(r.id ?? "")));
    const geocodedIds = toIdSet(geocodedRows.map((r) => String(r.id ?? "")));

    const geocodedById = indexById(geocodedRows);

    const footprintResults = await readJsonIfExists<any>(FOOTPRINT_RESULTS);
    const footprintIds = toIdSet((footprintResults?.results ?? []).map((r: any) => String(r.building_id ?? "")));

    const geometries = await readJsonIfExists<Record<string, any>>(GEOMETRIES);
    const geometryIds = toIdSet(Object.keys(geometries ?? {}));

    const geojson = await readJsonIfExists<any>(GEOJSON);
    const geojsonIds = toIdSet((geojson?.features ?? []).map((f: any) => String(f?.id ?? f?.properties?.id ?? "")));

    const missingFromGeocoded = diff(canonicalIds, geocodedIds);
    const missingFromFootprints = diff(geocodedIds, footprintIds);
    const missingFromGeometries = diff(geocodedIds, geometryIds);
    const missingFromGeojson = diff(geocodedIds, geojsonIds);

    // Attach last-known state for missing ids (from geocoded if available, else canonical)
    const canonicalById = indexById(canonicalRows);
    const enrich = (ids: string[]) =>
      ids.map((id) => {
        const g = geocodedById[id];
        const c = canonicalById[id];
        const src = g ?? c ?? {};
        return {
          id,
          name: src.name ?? "",
          address: src.address ?? "",
          lat: g?.lat ?? "",
          lon: g?.lon ?? "",
          geocode_display_name: g?.geocode_display_name ?? "",
        };
      });

    const footprintStatusCounts: Record<string, number> = {};
    for (const r of footprintResults?.results ?? []) {
      const status = String(r.status ?? "unknown");
      footprintStatusCounts[status] = (footprintStatusCounts[status] ?? 0) + 1;
    }

    const summary = {
      area: AREA_SLUG,
      paths: {
        canonical: CANONICAL,
        geocoded: GEOCODED,
        footprint_results: FOOTPRINT_RESULTS,
        geometries: GEOMETRIES,
        geojson: GEOJSON,
        out: OUT,
      },
      counts: {
        canonical: canonicalIds.size,
        geocoded: geocodedIds.size,
        footprint_results: footprintIds.size,
        geometries: geometryIds.size,
        geojson_features: geojsonIds.size,
      },
      deltas: {
        missing_from_geocoded: missingFromGeocoded.length,
        missing_from_footprint_results: missingFromFootprints.length,
        missing_from_geometries: missingFromGeometries.length,
        missing_from_geojson: missingFromGeojson.length,
      },
      missing_ids: {
        missing_from_geocoded: enrich(missingFromGeocoded),
        missing_from_footprint_results: enrich(missingFromFootprints),
        missing_from_geometries: enrich(missingFromGeometries),
        missing_from_geojson: enrich(missingFromGeojson),
      },
      footprint_status_counts: footprintStatusCounts,
    };

    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(summary, null, 2), "utf8");

    console.log(`✅ Wrote ${OUT}`);
    console.log(`📊 GeoJSON features: ${geojsonIds.size}/${geocodedIds.size}`);

    return summary;
  }, "Pipeline summary");

  if (!result.success) {
    console.error("❌ pipeline_summary failed:", result.errors);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ pipeline_summary crashed:", e);
  process.exit(1);
});

