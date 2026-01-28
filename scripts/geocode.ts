import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { validateCoordinates, withErrorHandling, writeValidationReport } from "./validation";
import type { CanonicalRow } from "./types";


type GeocodeCacheEntry = {
  lat: number | null;
  lon: number | null;
  display_name?: string;
  osm_type?: string; // N / W / R
  osm_id?: number;
  raw?: unknown; // optional for debugging
};

// Accept area as command line argument, default to combined for backward compatibility
const AREA_SLUG = process.argv[2] || "combined";

const INPUT_CSV = path.join("input", "canonical", `buildings_${AREA_SLUG}_canonical.csv`);
const OUTPUT_CSV = path.join("input", "canonical", `buildings_${AREA_SLUG}_geocoded.csv`);
const CACHE_PATH = path.join("cache", `geocode_${AREA_SLUG}.json`);

// Be a good citizen: 1 request / second
const RATE_LIMIT_MS = 1100;

// Nominatim usage policy expects a valid UA identifying your app + contact
const USER_AGENT = "zagreb-buildings-info-app/0.1 (contact: lukaklincic@hotmail.com)";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(a: string) {
  return a.trim().replace(/\s+/g, " ");
}

function choosePrimaryAddress(addr: string): string {
  const parts = addr.split("/").map((s) => s.trim());

  const trg = parts.find((p) => /trg bana/i.test(p));

  return trg ?? parts[0];
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

type AddressPartLike = { raw?: string; normalized?: string };

function addressQueriesForRow(r: CanonicalRow): string[] {
  const fromJson =
    safeJsonParse<AddressPartLike[]>(r.addresses_json)?.map((p) => p.normalized || p.raw || "").filter(Boolean) ?? [];

  const fromSplit = String(r.address ?? "")
    .split("/")
    .map((s) => normalizeAddress(s));

  // Prefer explicit `primary_address` if present, then the rest.
  const primary = r.primary_address ? normalizeAddress(r.primary_address) : normalizeAddress(choosePrimaryAddress(r.address));

  const combined = uniqueCaseInsensitive([primary, ...fromJson, ...fromSplit]);
  // Avoid sending multi-address strings with '/' to Nominatim; always geocode individual variants.
  return combined.filter((q) => q && !q.includes("/"));
}

function scoreGeocodeEntry(entry: GeocodeCacheEntry, query: string): number {
  // Higher is better. Deterministic based on returned hit metadata.
  let s = 0;

  if (entry.lat == null || entry.lon == null || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) {
    return -1_000_000;
  }

  const raw = (entry.raw ?? {}) as any;
  const category = String(raw.category ?? "");
  const addresstype = String(raw.addresstype ?? "");
  const type = String(raw.type ?? "");

  // Prefer building-level hits
  if (category === "building") s += 300;
  if (addresstype === "building") s += 250;

  // Penalize common "place" and "square" results (landmark centerpoints)
  if (category === "place" && (type === "square" || addresstype === "square")) s -= 250;
  if (category === "leisure" && type === "park") s -= 200;
  if (category === "highway") s -= 250;

  // Small positive bias toward objects (ways/relations) vs nodes
  if (entry.osm_type === "way" || entry.osm_type === "relation") s += 50;

  // House number presence in display name (helps distinguish square vs address)
  const hnMatch = query.match(/\b(\d+[A-Za-z]?)\b/);
  const display = String(entry.display_name ?? "").toLowerCase();
  if (hnMatch) {
    const hn = hnMatch[1].toLowerCase();
    if (display.startsWith(`${hn},`)) s += 80;
    else if (display.includes(` ${hn},`)) s += 50;
  }

  return s;
}


async function readJsonIfExists<T>(p: string, fallback: T): Promise<T> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}



async function geocodeNominatim(address: string): Promise<GeocodeCacheEntry> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "0");

  const maxAttempts = 3;
  let lastErr: unknown = null;
  let res: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch(url.toString(), {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en",
        },
      });

      if (!res.ok) {
        const retryable = [429, 502, 503, 504].includes(res.status);
        if (retryable && attempt < maxAttempts) {
          const backoffMs = 800 * 2 ** (attempt - 1);
          await sleep(backoffMs);
          continue;
        }
        return { lat: null, lon: null, raw: { status: res.status, statusText: res.statusText } };
      }

      break;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const backoffMs = 800 * 2 ** (attempt - 1);
        await sleep(backoffMs);
        continue;
      }
    }
  }

  if (!res) {
    return { lat: null, lon: null, raw: { error: String(lastErr ?? "fetch failed") } };
  }

  let data: any[] = [];
  try {
    data = (await res.json()) as any[];
  } catch (e) {
    return { lat: null, lon: null, raw: { error: "invalid_json", detail: String(e) } };
  }

  if (!data || data.length === 0) return { lat: null, lon: null, raw: [] };
  
  // crude housenumber extraction from query string
  const houseNumberMatch = address.match(/\b(\d+[A-Za-z]?)\b/);
  const houseNumber = houseNumberMatch ? houseNumberMatch[1].toLowerCase() : null;
  
  function score(hit: any) {
    let s = 0;
  
    const category = String(hit.category ?? "");
    const addresstype = String(hit.addresstype ?? "");
    const display = String(hit.display_name ?? "").toLowerCase();
  
    // Prefer actual buildings / address-level results
    if (category === "building") s += 120;
    if (addresstype === "building") s += 100;
  
    // Penalize roads/streets
    if (category === "highway") s -= 80;
  
    // Prefer hits that actually mention the house number
    if (houseNumber) {
      if (display.startsWith(`${houseNumber},`)) s += 80;
      else if (display.includes(` ${houseNumber},`)) s += 50;
    }
  
    // Prefer more specific objects (often higher place_rank means more specific; not perfect)
    if (typeof hit.place_rank === "number") s += Math.min(20, hit.place_rank);
  
    return s;
  }
  
  const hit = [...data].sort((a, b) => score(b) - score(a))[0];
  
  const lat = hit.lat ? Number(hit.lat) : null;
  const lon = hit.lon ? Number(hit.lon) : null;
  
  return {
    lat: Number.isFinite(lat as number) ? (lat as number) : null,
    lon: Number.isFinite(lon as number) ? (lon as number) : null,
    display_name: hit.display_name,
    osm_type: hit.osm_type,
    osm_id: hit.osm_id ? Number(hit.osm_id) : undefined,
    raw: hit,
  };
}

async function main() {
  const result = await withErrorHandling(async () => {
    // Ensure cache dir exists
    await fs.mkdir("cache", { recursive: true });

    const csvText = await fs.readFile(INPUT_CSV, "utf8");
    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as CanonicalRow[];

    console.log(`📊 Processing ${rows.length} building records for geocoding`);

    // Enhanced validation
    const required = [
      "id",
      "name",
      "address",
      "description",
      "architects",
      "source_url",
      "image_full_url",
      "image_thumb_url",
      "built_year",
    ] as const;

    for (const [i, r] of rows.entries()) {
      for (const k of required) {
        if (!(k in r)) throw new Error(`Missing column '${k}' in row ${i + 2}`);
      }
      if (!r.id?.trim()) throw new Error(`Row ${i + 2}: empty id`);
    }

    const cache = await readJsonIfExists<Record<string, GeocodeCacheEntry>>(CACHE_PATH, {});

    const out: Array<
      CanonicalRow & {
        lat: string;
        lon: string;
        geocode_display_name: string;
        geocode_query: string;
        geocode_osm_type: string;
        geocode_osm_id: string;
        geocode_category: string;
        geocode_addresstype: string;
      }
    > = [];
    const validationResults = [];

    let geocodingSuccess = 0;
    let geocodingFailed = 0;
    let cacheHits = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const queries = addressQueriesForRow(r);
      const scoredCandidates: Array<{ query: string; entry: GeocodeCacheEntry; score: number }> = [];

      for (const q of queries) {
        const cacheKey = q.toLowerCase();
        let entry = cache[cacheKey];

        if (!entry) {
          console.log(`[${i + 1}/${rows.length}] Geocoding: ${q}`);
          entry = await geocodeNominatim(q);
          cache[cacheKey] = entry;
          await writeJson(CACHE_PATH, cache);
          await sleep(RATE_LIMIT_MS);
        } else {
          cacheHits++;
        }

        scoredCandidates.push({
          query: q,
          entry,
          score: scoreGeocodeEntry(entry, q),
        });
      }

      // Name-assisted query for landmarks: only if the best hit looks like a square/place.
      const bestSoFar = [...scoredCandidates].sort((a, b) => b.score - a.score)[0];
      const bestRaw = (bestSoFar?.entry.raw ?? {}) as any;
      const bestCategory = String(bestRaw.category ?? "");
      const bestType = String(bestRaw.type ?? "");
      const looksLikeLandmark = bestCategory === "place" && bestType === "square";

      if (looksLikeLandmark && queries.length > 0) {
        const q = normalizeAddress(`${r.name}, ${queries[0]}`);
        const cacheKey = q.toLowerCase();
        let entry = cache[cacheKey];

        if (!entry) {
          console.log(`[${i + 1}/${rows.length}] Geocoding (name-assisted): ${q}`);
          entry = await geocodeNominatim(q);
          cache[cacheKey] = entry;
          await writeJson(CACHE_PATH, cache);
          await sleep(RATE_LIMIT_MS);
        } else {
          cacheHits++;
        }

        scoredCandidates.push({
          query: q,
          entry,
          score: scoreGeocodeEntry(entry, q),
        });
      }

      // Pick best deterministically: score desc, then candidate order.
      scoredCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return queries.indexOf(a.query) - queries.indexOf(b.query);
      });

      const chosen = scoredCandidates[0];
      const entry = chosen?.entry ?? { lat: null, lon: null };
      const geocode_query = chosen?.query ?? "";
      const raw = (entry.raw ?? {}) as any;
      const geocode_category = String(raw.category ?? "");
      const geocode_addresstype = String(raw.addresstype ?? "");

      // Validate geocoding results
      const validation = validateCoordinates(entry.lat, entry.lon);
      validationResults.push(validation);

      if (validation.isValid) {
        geocodingSuccess++;
      } else {
        geocodingFailed++;
        console.warn(`⚠️  Geocoding validation failed for "${geocode_query}":`, validation.errors);
      }

      out.push({
        ...r,
        lat: entry.lat === null ? "" : String(entry.lat),
        lon: entry.lon === null ? "" : String(entry.lon),
        geocode_display_name: entry.display_name ?? "",
        geocode_query,
        geocode_osm_type: entry.osm_type ? String(entry.osm_type) : "",
        geocode_osm_id: entry.osm_id == null ? "" : String(entry.osm_id),
        geocode_category,
        geocode_addresstype,
      });
    }

    const outCsv = stringify(out, {
      header: true,
      columns: [
        "id",
        "name",
        "address",
        "address_raw",
        "primary_address",
        "addresses_json",
        "description",
        "architects",
        "source_url",
        "image_full_url",
        "image_thumb_url",
        "built_year",
        "lat",
        "lon",
        "geocode_display_name",
        "geocode_query",
        "geocode_osm_type",
        "geocode_osm_id",
        "geocode_category",
        "geocode_addresstype",
      ],
    });

    await fs.writeFile(OUTPUT_CSV, outCsv, "utf8");

    // Write geocoding validation report
    const geocodingReportPath = path.join("output", "geocoding_validation.json");
    await writeValidationReport(geocodingReportPath, validationResults, "Geocoding Validation");

    console.log(`\n✅ Wrote ${OUTPUT_CSV}`);
    console.log(`✅ Cache updated at ${CACHE_PATH}`);
    console.log(`📊 Geocoding results: ${geocodingSuccess} success, ${geocodingFailed} failed, ${cacheHits} cache hits`);

    return {
      totalRecords: rows.length,
      geocodingSuccess,
      geocodingFailed,
      cacheHits
    };

  }, "Geocoding process");

  if (!result.success) {
    console.error("❌ Geocoding failed with errors:", result.errors);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ geocode failed:", err);
  process.exit(1);
});
