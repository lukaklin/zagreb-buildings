import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { withErrorHandling, writeValidationReport } from "./validation.ts";
import turfArea from "@turf/area";

type CanonicalRow = {
  id: string;
  name: string;
  address: string;
  description: string;
  architects: string;
  source_url: string;

  image_full_url: string;
  image_thumb_url: string;
  built_year: string;
};


type GeometryPick = {
  osm_ref: string; // e.g. "way/123456" or "relation/789"
  geometry: GeoJSON.Geometry;
};

// Accept area as command line argument, default to combined for backward compatibility
const AREA_SLUG = process.argv[2] || "combined";

const CANONICAL_CSV = path.join("input", "canonical", `buildings_${AREA_SLUG}_geocoded.csv`);
const GEOMS_PATH = path.join("output", `geometries_${AREA_SLUG}.json`);
const OUT_GEOJSON = path.join("public", "data", `buildings_${AREA_SLUG}.geojson`);
const QA_REPORT = path.join("output", `qa_report_${AREA_SLUG}.json`);

function splitArchitects(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function main() {
  const result = await withErrorHandling(async () => {
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

    console.log(`📊 Building GeoJSON from ${rows.length} canonical records and ${Object.keys(geomMap).length} geometries`);

    const features: GeoJSON.Feature[] = [];
    const missingGeometry: string[] = [];
    const validationResults = [];

    // Geometry area statistics
    const areas: number[] = [];

    for (const r of rows) {
      const pick = geomMap[r.id];

      if (!pick || !pick.geometry) {
        missingGeometry.push(r.id);
        continue;
      }

      // Calculate area for statistics
      try {
        const area = turfArea({
          type: 'Feature',
          geometry: pick.geometry,
          properties: {}
        });
        areas.push(area);
      } catch (e) {
        console.warn(`Could not calculate area for ${r.id}:`, e);
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

          imageFullUrl: r.image_full_url || undefined,
          imageThumbUrl: r.image_thumb_url || undefined,
          builtYear: r.built_year || "Unknown",

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

    // Comprehensive QA report
    const qa = {
      timestamp: new Date().toISOString(),
      summary: {
        total_rows: rows.length,
        features_written: features.length,
        missing_geometry_count: missingGeometry.length,
        match_rate: `${((features.length / rows.length) * 100).toFixed(1)}%`
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
