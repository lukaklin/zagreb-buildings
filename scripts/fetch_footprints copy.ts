import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import osmtogeojson from "osmtogeojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import turfArea from "@turf/area";
import { validateGeometry, withErrorHandling, writeValidationReport } from "./validation.ts";


type GeocodedRow = {
  id: string;
  name: string;
  address: string;
  description: string;
  architects: string;
  source_url: string;
  lat: string;
  lon: string;
  geocode_display_name: string;
};

type OverrideRow = {
  building_id: string;
  osm_type: "way" | "relation";
  osm_id: string;
  note?: string;
};

type GeometryPick = {
    osm_ref: string; // "way/123" or "relation/456"
    geometry: GeoJSON.Geometry;
  };
  
  type GeometryMap = Record<string, GeometryPick>;
  
type OverpassCacheFile =
  | {
      meta: { lat: number; lon: number; radius_m: number };
      overpass: any;
    }
  | any; // old format fallback

// Accept area as command line argument, default to combined for backward compatibility
const AREA_SLUG = process.argv[2] || "combined";

const INPUT = path.join("input", "canonical", `buildings_${AREA_SLUG}_geocoded.csv`);
const OVERRIDES = path.join("input", "overrides", `matches_${AREA_SLUG}.csv`);
const CACHE_DIR = path.join("cache", `overpass_${AREA_SLUG}`);
const OUTPUT = path.join("output", `geometries_${AREA_SLUG}.json`);

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const RATE_LIMIT_MS = 1500;

// search radius (meters). Start modest to avoid wrong matches.
const RADIUS_M = 80;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function readTextIfExists(p: string) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function parseOverrides(csvText: string | null): Record<string, OverrideRow> {
  if (!csvText) return {};
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as any[];
  const map: Record<string, OverrideRow> = {};
  for (const r of rows) {
    if (!r.building_id) continue;
    if (!r.osm_type || !r.osm_id) continue;
    map[r.building_id] = {
      building_id: String(r.building_id),
      osm_type: String(r.osm_type) as any,
      osm_id: String(r.osm_id),
      note: r.note ? String(r.note) : "",
    };
  }
  return map;
}

function overpassQuery(lat: number, lon: number, radiusM: number) {
  // Get building ways + relations near the point; include full geometry (via (._;>;);)
  return `
[out:json][timeout:25];
(
  way["building"](around:${radiusM},${lat},${lon});
  relation["building"](around:${radiusM},${lat},${lon});
);
(._;>;);
out body;
`;
}

async function fetchOverpass(query: string): Promise<any> {
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      // UA helps but Overpass isn't as strict as Nominatim; still good practice
      "User-Agent": "zagreb-buildings-info-app/0.1",
    },
    body: new URLSearchParams({ data: query }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Overpass error ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Very light-weight polygon area estimate (planar, good enough for ranking nearby candidates)
function ringArea(coords: number[][]) {
  // coords: [[lon,lat],...]
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function geometryCentroid(geom: GeoJSON.Geometry): { lat: number; lon: number } | null {
  // centroid approximation for Polygon/MultiPolygon: average of vertices
  const points: Array<[number, number]> = [];
  const pushRing = (ring: number[][]) => {
    for (const p of ring) points.push([p[0], p[1]]);
  };

  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) pushRing(ring as any);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) for (const ring of poly as any) pushRing(ring);
  } else {
    return null;
  }

  if (points.length === 0) return null;
  const avgLon = points.reduce((s, p) => s + p[0], 0) / points.length;
  const avgLat = points.reduce((s, p) => s + p[1], 0) / points.length;
  return { lat: avgLat, lon: avgLon };
}

function geometryAreaScore(geom: GeoJSON.Geometry): number {
  // Higher is “bigger”. We only use for ranking sanity; not real m².
  if (geom.type === "Polygon") {
    const outer = geom.coordinates[0] as any as number[][];
    return ringArea(outer);
  }
  if (geom.type === "MultiPolygon") {
    let sum = 0;
    for (const poly of geom.coordinates as any) {
      const outer = poly[0] as number[][];
      sum += ringArea(outer);
    }
    return sum;
  }
  return 0;
}

function toFeatures(overpassJson: any): GeoJSON.Feature[] {
  const gj = osmtogeojson(overpassJson) as GeoJSON.FeatureCollection;
  return (gj.features || []).filter(
    (f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
}

function osmIdentity(f: GeoJSON.Feature) {
  // osmtogeojson uses id like "way/123" or "relation/456"
  const idStr = String((f as any).id ?? "");
  const [t, id] = idStr.split("/");
  return { type: t, id };
}

function extractHouseNumberFromAddress(addr: string): string | null {
    // handles "10A", "1 - 1A", "29/1" (we take the first plausible token)
    const m = addr.match(/\b(\d+[A-Za-z]?)\b/);
    return m ? m[1] : null;
  }
  
  function addrMatches(featureProps: any, canonicalAddress: string): number {
    // Returns a bonus score (0..)
    const hn = extractHouseNumberFromAddress(canonicalAddress);
    const osmHN = featureProps?.["addr:housenumber"] ? String(featureProps["addr:housenumber"]) : null;
    const osmStreet = featureProps?.["addr:street"] ? String(featureProps["addr:street"]) : null;
  
    let bonus = 0;
  
    if (hn && osmHN && osmHN.toLowerCase() === hn.toLowerCase()) bonus += 120;
  
    // street match: weak, but helpful
    if (osmStreet) {
      const canon = canonicalAddress.toLowerCase();
      const osm = osmStreet.toLowerCase();
      if (canon.includes(osm)) bonus += 60;
    }
  
    return bonus;
  }
  

  function pickBest(
    features: GeoJSON.Feature[],
    targetLat: number,
    targetLon: number,
    canonicalAddress: string,
    override?: OverrideRow
  ): { feature: GeoJSON.Feature | null; strategy: string; confidence: 'high' | 'medium' | 'low' } {
    if (features.length === 0) return { feature: null, strategy: 'no_candidates', confidence: 'low' };

    // 1) Override wins if present in candidates
    if (override) {
      const want = `${override.osm_type}/${override.osm_id}`;
      const exact = features.find((f) => String((f as any).id) === want);
      if (exact) return { feature: exact, strategy: 'override_match', confidence: 'high' };
    }

    const p = turfPoint([targetLon, targetLat]);

    // Filter and validate features
    const validFeatures = features.filter((f) => {
      const validation = validateGeometry(f.geometry);
      return validation.isValid;
    });

    if (validFeatures.length === 0) {
      return { feature: null, strategy: 'no_valid_geometries', confidence: 'low' };
    }

    // Precompute for scoring
    const scored = validFeatures
      .map((f) => {
        const geom = f.geometry as GeoJSON.Geometry;
        const props = (f.properties ?? {}) as any;

        // Containment check (works for Polygon/MultiPolygon)
        let contains = false;
        try {
          contains = booleanPointInPolygon(p, f as any);
        } catch {
          contains = false;
        }

        // Area (m²-ish via turf)
        let area = 0;
        try {
          area = turfArea(f as any);
        } catch {
          area = 0;
        }

        // Distance to centroid
        const c = geometryCentroid(geom);
        const dist = c
          ? haversineMeters(targetLat, targetLon, c.lat, c.lon)
          : Number.POSITIVE_INFINITY;

        const addrBonus = addrMatches(props, canonicalAddress);

        // Base score: prefer containment heavily, then addrBonus, then distance, then smaller area
        // Higher score is better
        const score =
          (contains ? 10_000 : 0) +
          addrBonus +
          Math.max(0, 500 - dist) + // closer is better; cap helps stability
          Math.max(0, 2000 - area / 10); // prefer smaller polygons; area scaled down

        return { f, score, contains, dist, area, addrBonus, id: String((f as any).id ?? "") };
      })
      .filter((x) => Number.isFinite(x.score));

    if (scored.length === 0) return { feature: null, strategy: 'scoring_failed', confidence: 'low' };

    // 2) If any candidates contain the point, restrict to those
    const containing = scored.filter((x) => x.contains);
    const pool = containing.length ? containing : scored;

    // 3) Sort: score desc, then smaller area, then distance
    pool.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.area !== b.area) return a.area - b.area;
      return a.dist - b.dist;
    });

    const best = pool[0];
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let strategy = 'fallback_matching';

    if (best.contains && best.addrBonus >= 60) {
      confidence = 'high';
      strategy = 'point_containment_with_address';
    } else if (best.contains) {
      confidence = 'medium';
      strategy = 'point_containment_only';
    } else if (best.addrBonus >= 60) {
      confidence = 'medium';
      strategy = 'address_match_only';
    }

    return { feature: best.f, strategy, confidence };
  }

  /**
   * Fallback matching with expanded search radius
   */
  async function findGeometryWithFallback(
    buildingId: string,
    lat: number,
    lon: number,
    canonicalAddress: string,
    override?: OverrideRow
  ): Promise<{ geometry: GeoJSON.Geometry | null; osm_ref: string; strategy: string; confidence: string }> {
    const maxRadius = 200; // meters
    const radiusSteps = [RADIUS_M, 120, 160, maxRadius];

    for (const radius of radiusSteps) {
      console.log(`    Trying radius ${radius}m for ${buildingId}`);

      const query = overpassQuery(lat, lon, radius);
      const overpassJson = await fetchOverpass(query);
      const features = toFeatures(overpassJson);

      const result = pickBest(features, lat, lon, canonicalAddress, override);

      if (result.feature) {
        const osm_ref = String((result.feature as any).id ?? "");
        return {
          geometry: result.feature.geometry as GeoJSON.Geometry,
          osm_ref,
          strategy: `radius_${radius}m_${result.strategy}`,
          confidence: result.confidence
        };
      }
    }

    // Final fallback: try without radius constraint (nearby buildings only)
    console.log(`    Final fallback: searching nearby buildings for ${buildingId}`);
    const fallbackQuery = `
[out:json][timeout:25];
(
  way["building"](around:100,${lat},${lon});
  relation["building"](around:100,${lat},${lon});
);
(._;>;);
out body;
`;
    try {
      const overpassJson = await fetchOverpass(fallbackQuery);
      const features = toFeatures(overpassJson);
      const result = pickBest(features, lat, lon, canonicalAddress, override);

      if (result.feature) {
        const osm_ref = String((result.feature as any).id ?? "");
        return {
          geometry: result.feature.geometry as GeoJSON.Geometry,
          osm_ref,
          strategy: `fallback_nearby_${result.strategy}`,
          confidence: result.confidence
        };
      }
    } catch (e) {
      console.warn(`      Fallback query failed:`, e);
    }

    return { geometry: null, osm_ref: "", strategy: "no_match_found", confidence: "low" };
  }

function nearlyEqual(a: number, b: number, eps = 1e-6) {
    return Math.abs(a - b) <= eps;
  }
  
  function isNewCacheFormat(x: any): x is { meta: { lat: number; lon: number; radius_m: number }; overpass: any } {
    return (
      x &&
      typeof x === "object" &&
      x.meta &&
      typeof x.meta.lat === "number" &&
      typeof x.meta.lon === "number" &&
      typeof x.meta.radius_m === "number" &&
      "overpass" in x
    );
  }
  
  async function writeOverpassCache(cachePath: string, lat: number, lon: number, radius_m: number, overpass: any) {
    const payload = { meta: { lat, lon, radius_m }, overpass };
    await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), "utf8");
  }  

  async function fetchOverpassById(osmType: "way" | "relation", osmId: string) {
    const query = `
  [out:json][timeout:25];
  ${osmType}(${osmId});
  (._;>;);
  out body;
  `;
    return fetchOverpass(query);
  }
  

async function main() {
  const result = await withErrorHandling(async () => {
    await ensureDir(CACHE_DIR);
    await ensureDir("output");

    const csvText = await fs.readFile(INPUT, "utf8");
    const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as GeocodedRow[];

    console.log(`📊 Processing ${rows.length} geocoded buildings for footprint matching`);

    const overrides = parseOverrides(await readTextIfExists(OVERRIDES));
    const geometries: GeometryMap = {};
    const validationResults = [];

    let successfulMatches = 0;
    let failedMatches = 0;
    let overrideMatches = 0;
    let fallbackMatches = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const lat = Number(r.lat);
      const lon = Number(r.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.log(`[${i + 1}/${rows.length}] ❌ Missing lat/lon for ${r.id}`);
        failedMatches++;
        continue;
      }

      const override = overrides[r.id];

      console.log(`[${i + 1}/${rows.length}] Processing ${r.id} (${override ? 'override' : 'auto'})`);

      // Try to find geometry with fallback strategies
      const matchResult = await findGeometryWithFallback(r.id, lat, lon, r.address, override);

      if (!matchResult.geometry) {
        console.log(`  -> ❌ No geometry found for ${r.id} after all fallback attempts`);
        failedMatches++;
        continue;
      }

      // Validate the matched geometry
      const geometryValidation = validateGeometry(matchResult.geometry);
      validationResults.push(geometryValidation);

      if (!geometryValidation.isValid) {
        console.warn(`⚠️  Geometry validation failed for ${r.id}:`, geometryValidation.errors);
        if (geometryValidation.warnings.length > 0) {
          console.warn(`   Warnings:`, geometryValidation.warnings);
        }
      }

      // Categorize match quality
      if (matchResult.strategy.includes('override')) {
        overrideMatches++;
      } else if (matchResult.strategy.includes('fallback') || matchResult.strategy.includes('radius_')) {
        fallbackMatches++;
      } else {
        successfulMatches++;
      }

      console.log(`  -> ✅ ${matchResult.strategy} (${matchResult.confidence} confidence)`);
      if (geometryValidation.warnings.length > 0) {
        console.log(`     ⚠️  ${geometryValidation.warnings.length} geometry warnings`);
      }

      geometries[r.id] = {
        osm_ref: matchResult.osm_ref,
        geometry: matchResult.geometry,
      };
    }

    await fs.writeFile(OUTPUT, JSON.stringify(geometries, null, 2), "utf8");

    // Write geometry validation report
    const geometryReportPath = path.join("output", "geometry_validation.json");
    await writeValidationReport(geometryReportPath, validationResults, "Geometry Validation");

    // Write matching summary
    const matchingSummary = {
      total_buildings: rows.length,
      successful_matches: successfulMatches,
      fallback_matches: fallbackMatches,
      override_matches: overrideMatches,
      failed_matches: failedMatches,
      match_rate: ((successfulMatches + fallbackMatches + overrideMatches) / rows.length * 100).toFixed(1) + '%'
    };

    const summaryPath = path.join("output", "footprint_matching_summary.json");
    await fs.writeFile(summaryPath, JSON.stringify(matchingSummary, null, 2), "utf8");

    console.log(`\n✅ Wrote ${OUTPUT}`);
    console.log(`📊 Matching results: ${matchingSummary.match_rate} success rate`);
    console.log(`   - Direct matches: ${successfulMatches}`);
    console.log(`   - Fallback matches: ${fallbackMatches}`);
    console.log(`   - Override matches: ${overrideMatches}`);
    console.log(`   - Failed: ${failedMatches}`);

    return matchingSummary;

  }, "Footprint fetching process");

  if (!result.success) {
    console.error("❌ Footprint fetching failed with errors:", result.errors);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ fetch_footprints failed:", e);
  process.exit(1);
});
