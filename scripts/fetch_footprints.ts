import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import osmtogeojson from "osmtogeojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import turfArea from "@turf/area";
import { validateGeometry, withErrorHandling, writeValidationReport } from "./validation";


type GeocodedRow = {
  id: string;
  name: string;
  address: string;
  address_raw?: string;
  primary_address?: string;
  addresses_json?: string;
  description: string;
  architects: string;
  source_url: string;
  lat: string;
  lon: string;
  geocode_display_name: string;
  geocode_query?: string;
  geocode_osm_type?: string;
  geocode_osm_id?: string;
  geocode_category?: string;
  geocode_addresstype?: string;
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

// Accept area as command line argument, default to combined for backward compatibility
const AREA_SLUG = process.argv[2] || "combined";

const INPUT = path.join("input", "canonical", `buildings_${AREA_SLUG}_geocoded.csv`);
const OVERRIDES = path.join("input", "overrides", `matches_${AREA_SLUG}.csv`);
const CACHE_DIR = path.join("cache", `overpass_${AREA_SLUG}`);
const OUTPUT = path.join("output", `geometries_${AREA_SLUG}.json`);
const OUTPUT_RESULTS = path.join("output", `footprint_results_${AREA_SLUG}.json`);

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// search radius (meters). Start modest to avoid wrong matches.
const RADIUS_M = 80;

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

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

function safeJsonParse<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v.trim());
  }
  return out;
}

type AddressPartLike = { raw?: string; normalized?: string; street?: string; house_number?: string };

function addressesForRow(r: GeocodedRow): string[] {
  const parts =
    safeJsonParse<AddressPartLike[]>(r.addresses_json)?.map((p) => p.normalized || p.raw || "").filter(Boolean) ?? [];

  const split = String(r.address ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  return uniqueCaseInsensitive([...parts, ...split, String(r.primary_address ?? "").trim(), String(r.address ?? "").trim()]).filter(Boolean);
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
  // Get building ways/relations (and building:part) near the point; include full geometry (via (._;>;);)
  return `
[out:json][timeout:25];
(
  way["building"](around:${radiusM},${lat},${lon});
  relation["building"](around:${radiusM},${lat},${lon});
  way["building:part"](around:${radiusM},${lat},${lon});
  relation["building:part"](around:${radiusM},${lat},${lon});
  relation["type"="building"](around:${radiusM},${lat},${lon});
);
(._;>;);
out body;
`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeForFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

async function fetchOverpass(query: string, cachePath?: string): Promise<any> {
  if (cachePath) {
    const cached = await readJsonIfExists<any>(cachePath);
    if (cached) return cached;
  }

  const maxAttempts = 4;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
        const retryable = [429, 502, 503, 504].includes(res.status);
        if (retryable && attempt < maxAttempts) {
          const backoffMs = 800 * 2 ** (attempt - 1);
          console.warn(`      ⚠️ Overpass ${res.status} retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`);
          await sleep(backoffMs);
          continue;
        }
        throw new Error(`Overpass error ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      }

      const json = await res.json();
      if (cachePath) {
        await writeJson(cachePath, json);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const backoffMs = 800 * 2 ** (attempt - 1);
        console.warn(`      ⚠️ Overpass fetch failed, retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`);
        await sleep(backoffMs);
        continue;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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


function toFeatures(overpassJson: any): GeoJSON.Feature[] {
  const gj = osmtogeojson(overpassJson) as GeoJSON.FeatureCollection;
  return (gj.features || []).filter(
    (f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );
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
  

function addrMatchesMulti(featureProps: any, canonicalAddresses: string[]): number {
  let best = 0;
  for (const a of canonicalAddresses) {
    best = Math.max(best, addrMatches(featureProps, a));
  }
  return best;
}

function tagClassFromProps(props: any): "building" | "building_part" | "typed_building_relation" | "unknown" {
  if (props?.["building:part"]) return "building_part";
  if (props?.building) return "building";
  if (props?.type === "building") return "typed_building_relation";
  return "unknown";
}

type ScoredCandidate = {
  osm_ref: string;
  score: number;
  contains: boolean;
  dist_m: number;
  area_m2: number;
  addr_bonus: number;
  tag_class: string;
  feature: GeoJSON.Feature;
};

function pickBest(
  features: GeoJSON.Feature[],
  targetLat: number,
  targetLon: number,
  canonicalAddresses: string[]
): { best: ScoredCandidate | null; strategy: string; confidence: "high" | "medium" | "low"; topCandidates: ScoredCandidate[] } {
  if (features.length === 0) {
    return { best: null, strategy: "no_candidates", confidence: "low", topCandidates: [] };
  }

  const p = turfPoint([targetLon, targetLat]);

  // Filter and validate features
  const validFeatures = features.filter((f) => validateGeometry(f.geometry).isValid);
  if (validFeatures.length === 0) {
    return { best: null, strategy: "no_valid_geometries", confidence: "low", topCandidates: [] };
  }

  const scored: ScoredCandidate[] = validFeatures
    .map((f) => {
      const geom = f.geometry as GeoJSON.Geometry;
      const props = (f.properties ?? {}) as any;
      const osm_ref = String((f as any).id ?? "");

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
      const dist = c ? haversineMeters(targetLat, targetLon, c.lat, c.lon) : Number.POSITIVE_INFINITY;

      const addrBonus = addrMatchesMulti(props, canonicalAddresses);
      const tagClass = tagClassFromProps(props);

      // Prefer containment heavily, then addrBonus, then distance, then smaller area.
      // Add a small preference for full building footprints over building parts.
      const tagBonus = tagClass === "building" ? 80 : tagClass === "building_part" ? -20 : 0;

      const score =
        (contains ? 10_000 : 0) +
        addrBonus +
        tagBonus +
        Math.max(0, 500 - dist) + // closer is better; cap helps stability
        Math.max(0, 2000 - area / 10); // prefer smaller polygons; area scaled down

      return {
        osm_ref,
        score,
        contains,
        dist_m: dist,
        area_m2: area,
        addr_bonus: addrBonus,
        tag_class: tagClass,
        feature: f,
      };
    })
    .filter((x) => Number.isFinite(x.score));

  if (scored.length === 0) {
    return { best: null, strategy: "scoring_failed", confidence: "low", topCandidates: [] };
  }

  // If any candidates contain the point, restrict to those
  const containing = scored.filter((x) => x.contains);
  const pool = containing.length ? containing : scored;

  // Deterministic sort: score desc, then smaller area, then distance, then osm_ref
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.area_m2 !== b.area_m2) return a.area_m2 - b.area_m2;
    if (a.dist_m !== b.dist_m) return a.dist_m - b.dist_m;
    return a.osm_ref.localeCompare(b.osm_ref);
  });

  const best = pool[0] ?? null;
  const second = pool[1] ?? null;

  let confidence: "high" | "medium" | "low" = "low";
  let strategy = "fallback_matching";

  if (best) {
    if (best.contains && best.addr_bonus >= 60) {
      confidence = "high";
      strategy = "point_containment_with_address";
    } else if (best.contains) {
      confidence = "medium";
      strategy = "point_containment_only";
    } else if (best.addr_bonus >= 60) {
      confidence = "medium";
      strategy = "address_match_only";
    }

    // If top 2 are very close and we don't have containment or a strong address bonus, mark low confidence.
    if (
      second &&
      !best.contains &&
      best.addr_bonus < 60 &&
      Math.abs(best.score - second.score) < 80
    ) {
      confidence = "low";
      strategy = "ambiguous_top2";
    }
  }

  return { best, strategy, confidence, topCandidates: pool.slice(0, 15) };
}

function overpassDirectQuery(osmType: "way" | "relation", osmId: string) {
  return `
[out:json][timeout:25];
${osmType}(${osmId});
(._;>;);
out body;
`;
}

function isTrustedGeocodeRef(r: GeocodedRow): { osm_type: "way" | "relation"; osm_id: string } | null {
  const osm_type = String(r.geocode_osm_type ?? "") as any;
  const osm_id = String(r.geocode_osm_id ?? "");
  const category = String(r.geocode_category ?? "");
  const addresstype = String(r.geocode_addresstype ?? "");

  if (!osm_id) return null;
  if (osm_type !== "way" && osm_type !== "relation") return null;

  // Only trust when Nominatim suggests a building-level object.
  if (category === "building" || addresstype === "building") {
    return { osm_type, osm_id };
  }

  return null;
}

function mergeBuildingParts(
  best: ScoredCandidate,
  candidates: ScoredCandidate[]
): { geometry: GeoJSON.Geometry; osm_refs: string[] } | null {
  if (best.tag_class !== "building_part") return null;

  const parts = candidates
    .filter((c) => c.tag_class === "building_part")
    .filter((c) => c.dist_m <= 80)
    .filter((c) => c.score >= best.score - 600)
    .slice(0, 10);

  if (parts.length < 2) return null;

  const polys: any[] = [];
  for (const p of parts) {
    const g = p.feature.geometry as GeoJSON.Geometry;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
  }

  if (polys.length === 0) return null;

  return {
    geometry: { type: "MultiPolygon", coordinates: polys } as GeoJSON.Geometry,
    osm_refs: parts.map((p) => p.osm_ref),
  };
}

type MatchAttemptResult = {
  geometry: GeoJSON.Geometry | null;
  osm_refs: string[];
  strategy: string;
  confidence: string;
  topCandidates: ScoredCandidate[];
  radii_tried: number[];
};

async function findGeometryWithFallback(
  buildingId: string,
  lat: number,
  lon: number,
  canonicalAddresses: string[],
  row: GeocodedRow,
  override?: OverrideRow
): Promise<MatchAttemptResult> {
  const radii_tried: number[] = [];

  // 0) Manual override: fetch exact object (most deterministic)
  if (override) {
    const osmType = override.osm_type;
    const osmId = override.osm_id;
    const cachePath = path.join(CACHE_DIR, `${sanitizeForFilename(buildingId)}__override_${osmType}_${osmId}.json`);
    try {
      const overpassJson = await fetchOverpass(overpassDirectQuery(osmType, osmId), cachePath);
      const features = toFeatures(overpassJson);
      const picked = pickBest(features, lat, lon, canonicalAddresses);
      if (picked.best) {
        return {
          geometry: picked.best.feature.geometry as GeoJSON.Geometry,
          osm_refs: [picked.best.osm_ref],
          strategy: `override_direct_${picked.strategy}`,
          confidence: picked.confidence,
          topCandidates: picked.topCandidates,
          radii_tried,
        };
      }
    } catch (e) {
      console.warn(`      ⚠️ Override direct fetch failed for ${buildingId}:`, e);
    }
  }

  // 1) Trusted Nominatim OSM ref: fetch exact object (fast + deterministic when it’s really a building)
  const trusted = isTrustedGeocodeRef(row);
  if (trusted) {
    const cachePath = path.join(CACHE_DIR, `${sanitizeForFilename(buildingId)}__geocode_${trusted.osm_type}_${trusted.osm_id}.json`);
    try {
      const overpassJson = await fetchOverpass(overpassDirectQuery(trusted.osm_type, trusted.osm_id), cachePath);
      const features = toFeatures(overpassJson);
      const picked = pickBest(features, lat, lon, canonicalAddresses);
      if (picked.best) {
        return {
          geometry: picked.best.feature.geometry as GeoJSON.Geometry,
          osm_refs: [picked.best.osm_ref],
          strategy: `direct_geocode_ref_${picked.strategy}`,
          confidence: picked.confidence,
          topCandidates: picked.topCandidates,
          radii_tried,
        };
      }
    } catch (e) {
      console.warn(`      ⚠️ Geocode direct fetch failed for ${buildingId}:`, e);
    }
  }

  // 2) Proximity search: expand radius slightly when geocode looks like a landmark/place
  const category = String(row.geocode_category ?? "");
  const addresstype = String(row.geocode_addresstype ?? "");
  const lowConfidenceGeocode = category !== "building" && addresstype !== "building" && category === "place";

  const radiusSteps = lowConfidenceGeocode ? [RADIUS_M, 120, 160, 200, 350] : [RADIUS_M, 120, 160, 200];

  for (const radius of radiusSteps) {
    radii_tried.push(radius);
    console.log(`    Trying radius ${radius}m for ${buildingId}`);

    const query = overpassQuery(lat, lon, radius);
    const cachePath = path.join(CACHE_DIR, `${sanitizeForFilename(buildingId)}__radius_${radius}.json`);

    let overpassJson: any;
    try {
      overpassJson = await fetchOverpass(query, cachePath);
    } catch (e) {
      console.warn(`      ⚠️ Overpass failed at radius ${radius}m for ${buildingId}, skipping radius`);
      continue;
    }

    const features = toFeatures(overpassJson);
    const picked = pickBest(features, lat, lon, canonicalAddresses);

    if (picked.best) {
      // If the best candidate is a building part, try to merge parts deterministically.
      const merged = mergeBuildingParts(picked.best, picked.topCandidates);
      if (merged) {
        return {
          geometry: merged.geometry,
          osm_refs: merged.osm_refs,
          strategy: `radius_${radius}m_parts_merged_${picked.strategy}`,
          confidence: picked.confidence,
          topCandidates: picked.topCandidates,
          radii_tried,
        };
      }

      return {
        geometry: picked.best.feature.geometry as GeoJSON.Geometry,
        osm_refs: [picked.best.osm_ref],
        strategy: `radius_${radius}m_${picked.strategy}`,
        confidence: picked.confidence,
        topCandidates: picked.topCandidates,
        radii_tried,
      };
    }
  }

  return {
    geometry: null,
    osm_refs: [],
    strategy: "no_match_found",
    confidence: "low",
    topCandidates: [],
    radii_tried,
  };
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

    type FootprintStatus = "matched" | "matched_parts_merged" | "ambiguous" | "not_found" | "invalid" | "skipped_no_coords";
    type FootprintResult = {
      building_id: string;
      status: FootprintStatus;
      strategy: string;
      confidence: string;
      osm_refs: string[];
      geometry: GeoJSON.Geometry | null;
      debug: {
        addresses: string[];
        radii_tried: number[];
        top_candidates: Array<{
          osm_ref: string;
          score: number;
          contains: boolean;
          dist_m: number;
          area_m2: number;
          addr_bonus: number;
          tag_class: string;
        }>;
      };
    };

    const results: FootprintResult[] = [];

    const counts: Record<string, number> = {
      matched: 0,
      matched_parts_merged: 0,
      ambiguous: 0,
      not_found: 0,
      invalid: 0,
      skipped_no_coords: 0,
      direct_geocode_ref: 0,
      override_direct: 0,
    };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const lat = Number(r.lat);
      const lon = Number(r.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.log(`[${i + 1}/${rows.length}] ❌ Missing lat/lon for ${r.id}`);
        counts.skipped_no_coords++;
        results.push({
          building_id: r.id,
          status: "skipped_no_coords",
          strategy: "skipped_no_coords",
          confidence: "low",
          osm_refs: [],
          geometry: null,
          debug: { addresses: addressesForRow(r), radii_tried: [], top_candidates: [] },
        });
        continue;
      }

      const override = overrides[r.id];

      console.log(`[${i + 1}/${rows.length}] Processing ${r.id} (${override ? 'override' : 'auto'})`);

      const addresses = addressesForRow(r);
      const matchResult = await findGeometryWithFallback(r.id, lat, lon, addresses, r, override);

      let status: FootprintStatus = "not_found";
      if (matchResult.geometry) {
        status = matchResult.strategy.includes("parts_merged") ? "matched_parts_merged" : "matched";
        if (matchResult.strategy.includes("ambiguous")) status = "ambiguous";
      }

      if (matchResult.strategy.startsWith("direct_geocode_ref")) counts.direct_geocode_ref++;
      if (matchResult.strategy.startsWith("override_direct")) counts.override_direct++;

      if (!matchResult.geometry) {
        console.log(`  -> ❌ No geometry found for ${r.id} after all attempts`);
        counts.not_found++;
        results.push({
          building_id: r.id,
          status,
          strategy: matchResult.strategy,
          confidence: matchResult.confidence,
          osm_refs: matchResult.osm_refs,
          geometry: null,
          debug: {
            addresses,
            radii_tried: matchResult.radii_tried,
            top_candidates: matchResult.topCandidates.map((c) => ({
              osm_ref: c.osm_ref,
              score: c.score,
              contains: c.contains,
              dist_m: c.dist_m,
              area_m2: c.area_m2,
              addr_bonus: c.addr_bonus,
              tag_class: c.tag_class,
            })),
          },
        });
        continue;
      }

      // Validate matched geometry; if invalid, keep record but do not emit geometry for downstream.
      const geometryValidation = validateGeometry(matchResult.geometry);
      validationResults.push(geometryValidation);
      if (!geometryValidation.isValid) {
        status = "invalid";
        counts.invalid++;
        console.warn(`⚠️  Geometry validation failed for ${r.id}:`, geometryValidation.errors);
      } else {
        counts[status] = (counts[status] ?? 0) + 1;
        // Back-compat map for downstream build step
        geometries[r.id] = {
          osm_ref: matchResult.osm_refs[0] ?? "",
          geometry: matchResult.geometry,
        };
      }

      console.log(`  -> ✅ ${matchResult.strategy} (${matchResult.confidence} confidence)`);
      if (geometryValidation.warnings.length > 0) {
        console.log(`     ⚠️  ${geometryValidation.warnings.length} geometry warnings`);
      }

      results.push({
        building_id: r.id,
        status,
        strategy: matchResult.strategy,
        confidence: matchResult.confidence,
        osm_refs: matchResult.osm_refs,
        geometry: geometryValidation.isValid ? matchResult.geometry : null,
        debug: {
          addresses,
          radii_tried: matchResult.radii_tried,
          top_candidates: matchResult.topCandidates.map((c) => ({
            osm_ref: c.osm_ref,
            score: c.score,
            contains: c.contains,
            dist_m: c.dist_m,
            area_m2: c.area_m2,
            addr_bonus: c.addr_bonus,
            tag_class: c.tag_class,
          })),
        },
      });
    }

    await fs.writeFile(OUTPUT, JSON.stringify(geometries, null, 2), "utf8");
    await fs.writeFile(OUTPUT_RESULTS, JSON.stringify({ area: AREA_SLUG, results, counts }, null, 2), "utf8");

    // Write geometry validation report
    const geometryReportPath = path.join("output", "geometry_validation.json");
    await writeValidationReport(geometryReportPath, validationResults, "Geometry Validation");

    // Write matching summary
    const matchingSummary = {
      total_buildings: rows.length,
      matched: counts.matched ?? 0,
      matched_parts_merged: counts.matched_parts_merged ?? 0,
      ambiguous: counts.ambiguous ?? 0,
      not_found: counts.not_found ?? 0,
      invalid: counts.invalid ?? 0,
      skipped_no_coords: counts.skipped_no_coords ?? 0,
      direct_geocode_ref: counts.direct_geocode_ref ?? 0,
      override_direct: counts.override_direct ?? 0,
      match_rate:
        (((counts.matched ?? 0) + (counts.matched_parts_merged ?? 0) + (counts.ambiguous ?? 0)) / rows.length * 100).toFixed(1) +
        "%",
    };

    const summaryPath = path.join("output", "footprint_matching_summary.json");
    await fs.writeFile(summaryPath, JSON.stringify(matchingSummary, null, 2), "utf8");

    console.log(`\n✅ Wrote ${OUTPUT}`);
    console.log(`✅ Wrote ${OUTPUT_RESULTS}`);
    console.log(`📊 Matching results: ${matchingSummary.match_rate} success rate`);
    console.log(`   - Matched: ${matchingSummary.matched}`);
    console.log(`   - Matched (parts merged): ${matchingSummary.matched_parts_merged}`);
    console.log(`   - Ambiguous (kept best): ${matchingSummary.ambiguous}`);
    console.log(`   - Not found: ${matchingSummary.not_found}`);
    console.log(`   - Invalid geometry: ${matchingSummary.invalid}`);

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
