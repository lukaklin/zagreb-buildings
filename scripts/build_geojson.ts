import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { withErrorHandling, writeValidationReport } from "./validation";
import type { ValidationResult } from "./validation";
import turfArea from "@turf/area";
import type { CanonicalRow } from "./types";


type GeometryPick = {
  osm_ref: string; // e.g. "way/123456" or "relation/789"
  geometry: GeoJSON.Geometry;
};

type FootprintResultFile = {
  area: string;
  results: Array<{
    building_id: string;
    status: string;
    strategy: string;
    confidence: string;
    osm_refs: string[];
    geometry: GeoJSON.Geometry | null;
  }>;
  counts?: Record<string, number>;
};

type GeocodedRow = CanonicalRow & {
  lat?: string;
  lon?: string;
};

// Accept area as command line argument, default to combined for backward compatibility
const AREA_SLUG = process.argv[2] || "combined";

const CANONICAL_CSV = path.join("input", "canonical", `buildings_${AREA_SLUG}_geocoded.csv`);
const GEOMS_PATH = path.join("output", `geometries_${AREA_SLUG}.json`);
const FOOTPRINT_RESULTS_PATH = path.join("output", `footprint_results_${AREA_SLUG}.json`);
const OUT_GEOJSON = path.join("public", "data", `buildings_${AREA_SLUG}.geojson`);
const QA_REPORT = path.join("output", `qa_report_${AREA_SLUG}.json`);

function splitArchitects(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

async function main() {
  const result = await withErrorHandling(async () => {
    // --- read canonical CSV ---
    const csvText = await fs.readFile(CANONICAL_CSV, "utf8");
    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as GeocodedRow[];

    // --- read geometries ---
    const geomMap = JSON.parse(
      await fs.readFile(GEOMS_PATH, "utf8")
    ) as Record<string, GeometryPick>;

    const footprintResults = await readJsonIfExists<FootprintResultFile>(FOOTPRINT_RESULTS_PATH);
    const footprintById: Record<string, FootprintResultFile["results"][number]> = {};
    if (footprintResults?.results) {
      for (const r of footprintResults.results) {
        footprintById[r.building_id] = r;
      }
    }

    console.log(
      `📊 Building GeoJSON from ${rows.length} geocoded records, ${Object.keys(geomMap).length} geometries, and ${Object.keys(footprintById).length} footprint results`
    );

    const features: GeoJSON.Feature[] = [];
    const missingGeometry: string[] = [];
    const validationResults: ValidationResult[] = [];

    // Geometry area statistics
    const areas: number[] = [];

    for (const r of rows) {
      const pick = geomMap[r.id];
      const fp = footprintById[r.id];

      const lat = Number((r as any).lat ?? "");
      const lon = Number((r as any).lon ?? "");
      const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);

      let geometry: GeoJSON.Geometry | null = fp?.geometry ?? pick?.geometry ?? null;
      let footprintStatus = fp?.status ?? (pick?.geometry ? "matched_legacy" : "not_found");
      let footprintStrategy = fp?.strategy ?? (pick?.geometry ? "legacy_geometries_map" : "none");
      let footprintConfidence = fp?.confidence ?? "";
      let footprintOsmRefs = fp?.osm_refs ?? (pick?.osm_ref ? [pick.osm_ref] : []);

      if (!geometry && hasPoint) {
        geometry = { type: "Point", coordinates: [lon, lat] };
        footprintStatus = "not_found_point_fallback";
        footprintStrategy = "point_fallback";
      }

      if (!geometry) {
        missingGeometry.push(r.id);
        continue;
      }

      // Calculate area for statistics
      if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
        try {
          const area = turfArea({
            type: "Feature",
            geometry,
            properties: {},
          });
          areas.push(area);
        } catch (e) {
          console.warn(`Could not calculate area for ${r.id}:`, e);
        }
      }

      features.push({
        type: "Feature",
        id: r.id,
        properties: {
          id: r.id,
          name: r.name,
          address: r.address,
          addressRaw: r.address_raw || undefined,
          description: r.description,
          architects: splitArchitects(r.architects),
          sourceUrl: r.source_url,

          imageFullUrl: r.image_full_url || undefined,
          imageThumbUrl: r.image_thumb_url || undefined,
          builtYear: r.built_year || "Unknown",

          osmRef: footprintOsmRefs?.[0] || pick?.osm_ref || undefined, // debugging helper
          osmRefs: footprintOsmRefs?.length ? footprintOsmRefs : undefined,
          footprintStatus,
          footprintStrategy,
          footprintConfidence,
          lat: hasPoint ? lat : undefined,
          lon: hasPoint ? lon : undefined,
        },
        geometry,
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

    // Comprehensive QA report
    const qa = {
      timestamp: new Date().toISOString(),
      summary: {
        total_rows: rows.length,
        features_written: features.length,
        missing_geometry_count: missingGeometry.length,
        point_features: features.filter((f) => (f.geometry as any)?.type === "Point").length,
        polygon_features: features.filter((f) => ["Polygon", "MultiPolygon"].includes((f.geometry as any)?.type)).length,
        match_rate: `${((features.length / rows.length) * 100).toFixed(1)}%`,
      },
      geometry_stats: areas.length > 0 ? {
        count: areas.length,
        min_area_m2: Math.min(...areas),
        max_area_m2: Math.max(...areas),
        avg_area_m2: areas.reduce((sum, a) => sum + a, 0) / areas.length,
        median_area_m2: areas.sort((a, b) => a - b)[Math.floor(areas.length / 2)]
      } : null,
      issues: {
        missing_geometry: missingGeometry,
        data_quality_warnings: validationResults.filter(r => r.warnings.length > 0).length,
        data_quality_errors: validationResults.filter(r => !r.isValid).length
      }
    };

    await fs.writeFile(QA_REPORT, JSON.stringify(qa, null, 2), "utf8");

    // Write detailed validation report
    const detailedQaPath = path.join("output", "geojson_build_validation.json");
    await writeValidationReport(detailedQaPath, validationResults, "GeoJSON Build Validation");

    console.log(`✅ Wrote ${OUT_GEOJSON}`);
    console.log(`✅ Wrote ${QA_REPORT}`);
    console.log(`📊 Build results: ${qa.summary.match_rate} match rate`);
    console.log(`   - Features: ${features.length}/${rows.length}`);
    if (missingGeometry.length > 0) {
      console.log(`   - Missing geometries: ${missingGeometry.length}`);
    }
    if (qa.geometry_stats) {
      console.log(`   - Area range: ${qa.geometry_stats.min_area_m2.toFixed(0)}-${qa.geometry_stats.max_area_m2.toFixed(0)} m²`);
    }

    return qa.summary;

  }, "GeoJSON build process");

  if (!result.success) {
    console.error("❌ GeoJSON build failed with errors:", result.errors);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ build_geojson failed:", err);
  process.exit(1);
});
