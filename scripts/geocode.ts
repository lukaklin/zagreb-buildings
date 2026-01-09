import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

type CanonicalRow = {
  id: string;
  name: string;
  address: string;
  description: string;
  architects: string;
  source_url: string;
};

type GeocodeCacheEntry = {
  lat: number | null;
  lon: number | null;
  display_name?: string;
  osm_type?: string; // N / W / R
  osm_id?: number;
  raw?: unknown; // optional for debugging
};

const INPUT_CSV = path.join("input", "canonical", "buildings_canonical.csv");
const OUTPUT_CSV = path.join("input", "canonical", "buildings_geocoded.csv");
const CACHE_PATH = path.join("cache", "geocode.json");

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
    const parts = addr.split("/").map(s => s.trim());
  
    const trg = parts.find(p =>
      /trg bana/i.test(p)
    );
  
    return trg ?? parts[0];
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

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en",
    },
  });

  if (!res.ok) {
    return { lat: null, lon: null, raw: { status: res.status, statusText: res.statusText } };
  }

  const data = (await res.json()) as any[];

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
  // Ensure cache dir exists
  await fs.mkdir("cache", { recursive: true });

  const csvText = await fs.readFile(INPUT_CSV, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CanonicalRow[];

  // Basic validation
  const required = ["id", "name", "address", "description", "architects", "source_url"] as const;
  for (const [i, r] of rows.entries()) {
    for (const k of required) {
      if (!(k in r)) throw new Error(`Missing column '${k}' in row ${i + 2}`);
    }
    if (!r.id?.trim()) throw new Error(`Row ${i + 2}: empty id`);
  }

  const cache = await readJsonIfExists<Record<string, GeocodeCacheEntry>>(CACHE_PATH, {});

  const out: Array<CanonicalRow & { lat: string; lon: string; geocode_display_name: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const addr = normalizeAddress(choosePrimaryAddress(r.address));
    const primaryAddr = addr.split("/")[0].trim();
    const cacheKey = primaryAddr.toLowerCase();
    
    let entry = cache[cacheKey];

    if (!entry) {
      console.log(`[${i + 1}/${rows.length}] Geocoding: ${primaryAddr} (from: ${addr})`);
      entry = await geocodeNominatim(primaryAddr);
      cache[cacheKey] = entry;
      await writeJson(CACHE_PATH, cache);
      await sleep(RATE_LIMIT_MS);
    } else {
      console.log(`[${i + 1}/${rows.length}] Cache hit: ${addr}`);
    }

    out.push({
      ...r,
      lat: entry.lat === null ? "" : String(entry.lat),
      lon: entry.lon === null ? "" : String(entry.lon),
      geocode_display_name: entry.display_name ?? "",
    });
  }

  const outCsv = stringify(out, {
    header: true,
    columns: [
      "id",
      "name",
      "address",
      "description",
      "architects",
      "source_url",
      "lat",
      "lon",
      "geocode_display_name",
    ],
  });

  await fs.writeFile(OUTPUT_CSV, outCsv, "utf8");
  console.log(`\n✅ Wrote ${OUTPUT_CSV}`);
  console.log(`✅ Cache updated at ${CACHE_PATH}\n`);
}

main().catch((err) => {
  console.error("❌ geocode failed:", err);
  process.exit(1);
});
