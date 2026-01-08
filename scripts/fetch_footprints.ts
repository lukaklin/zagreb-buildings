import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import osmtogeojson from "osmtogeojson";

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

type GeometryMap = Record<string, GeoJSON.Geometry>;

type OverpassCacheFile =
  | {
      meta: { lat: number; lon: number; radius_m: number };
      overpass: any;
    }
  | any; // old format fallback

const INPUT = path.join("input", "canonical", "buildings_geocoded.csv");
const OVERRIDES = path.join("input", "overrides", "matches.csv");
const CACHE_DIR = path.join("cache", "overpass");
const OUTPUT = path.join("output", "geometries.json");

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

function pickBest(
  features: GeoJSON.Feature[],
  targetLat: number,
  targetLon: number,
  override?: OverrideRow
): GeoJSON.Feature | null {
  if (features.length === 0) return null;

  if (override) {
    const want = `${override.osm_type}/${override.osm_id}`;
    const exact = features.find((f) => String((f as any).id) === want);
    if (exact) return exact;
    // If override refers to something not in results, we still fall back.
  }

  // Rank by distance first, then by area “sanity”
  const scored = features
    .map((f) => {
      const c = geometryCentroid(f.geometry as GeoJSON.Geometry);
      const dist = c ? haversineMeters(targetLat, targetLon, c.lat, c.lon) : Number.POSITIVE_INFINITY;
      const area = geometryAreaScore(f.geometry as GeoJSON.Geometry);
      return { f, dist, area };
    })
    .filter((x) => Number.isFinite(x.dist))
    .sort((a, b) => a.dist - b.dist);

  if (scored.length === 0) return null;

  // Simple sanity: prefer something not absurdly tiny if multiple are close.
  const best = scored[0];
  const close = scored.filter((x) => x.dist <= best.dist + 15); // within 15m of best
  close.sort((a, b) => b.area - a.area);
  return close[0].f;
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

async function main() {
  await ensureDir(CACHE_DIR);
  await ensureDir("output");

  const csvText = await fs.readFile(INPUT, "utf8");
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as GeocodedRow[];

  const overrides = parseOverrides(await readTextIfExists(OVERRIDES));
  const geometries: GeometryMap = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.log(`[${i + 1}/${rows.length}] ❌ Missing lat/lon for ${r.id}`);
      continue;
    }

    const cachePath = path.join(CACHE_DIR, `${r.id}.json`);
    let overpassJson: any;
    
    const cachedText = await readTextIfExists(cachePath);
    
    let shouldFetch = true;
    
    if (cachedText) {
      const cachedObj: OverpassCacheFile = JSON.parse(cachedText);
    
      if (isNewCacheFormat(cachedObj)) {
        const sameLat = nearlyEqual(cachedObj.meta.lat, lat);
        const sameLon = nearlyEqual(cachedObj.meta.lon, lon);
        const sameRadius = cachedObj.meta.radius_m === RADIUS_M;
    
        if (sameLat && sameLon && sameRadius) {
          overpassJson = cachedObj.overpass;
          shouldFetch = false;
          console.log(`[${i + 1}/${rows.length}] Cache hit Overpass for ${r.id}`);
        } else {
          console.log(
            `[${i + 1}/${rows.length}] Cache stale for ${r.id} (coords/radius changed) -> refetching`
          );
        }
      } else {
        // Old cache format (raw Overpass JSON). Refetch once to migrate.
        console.log(`[${i + 1}/${rows.length}] Old cache format for ${r.id} -> refetching to migrate`);
      }
    }
    
    if (shouldFetch) {
      console.log(`[${i + 1}/${rows.length}] Overpass fetch for ${r.id} (r=${RADIUS_M}m)`);
      const q = overpassQuery(lat, lon, RADIUS_M);
      overpassJson = await fetchOverpass(q);
      await writeOverpassCache(cachePath, lat, lon, RADIUS_M, overpassJson);
      await sleep(RATE_LIMIT_MS);
    }    

    const feats = toFeatures(overpassJson);
    const override = overrides[r.id];
    const best = pickBest(feats, lat, lon, override);

    if (!best || !best.geometry) {
      console.log(`  -> ❌ No polygon match for ${r.id}`);
      continue;
    }

    const oid = osmIdentity(best);
    console.log(`  -> ✅ picked ${(best as any).id} (type=${oid.type} id=${oid.id})`);

    geometries[r.id] = best.geometry as GeoJSON.Geometry;
  }

  await fs.writeFile(OUTPUT, JSON.stringify(geometries, null, 2), "utf8");
  console.log(`\n✅ Wrote ${OUTPUT}\n`);
}

main().catch((e) => {
  console.error("❌ fetch_footprints failed:", e);
  process.exit(1);
});
