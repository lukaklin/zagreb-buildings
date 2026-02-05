// scripts/scrape_and_normalize.ts
// Combined script that scrapes a street from arhitektura-zagreba.com and normalizes to canonical CSV

import { promises as fs } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify/sync";
import {
  validateRawBuildingRecord,
  detectIdCollisions,
  withErrorHandling,
  writeValidationReport
} from "./validation";
import type { RawBuilding, CanonicalRow } from "./types";

// Accept area as command line argument
const AREA_SLUG = process.argv[2];

if (!AREA_SLUG) {
  console.error("Usage: tsx scripts/scrape_and_normalize.ts <area-slug>");
  console.error("Example: tsx scripts/scrape_and_normalize.ts teslina");
  process.exit(1);
}

// Paths
const LIST_URL = `https://www.arhitektura-zagreba.com/ulice/${AREA_SLUG}`;
const RAW_PATH = path.join("input", "raw", `arhitektura-zagreba.${AREA_SLUG}.jsonl`);
const OUT_CSV = path.join("input", "canonical", `buildings_${AREA_SLUG}_canonical.csv`);
const OUT_DUPE = path.join("output", `possible_duplicates_${AREA_SLUG}.json`);
const CACHE_DIR = path.join("cache", "html");

const USER_AGENT = "zagreb-buildings-info-app/0.1 (contact: lukaklincic@hotmail.com)";
const SLEEP_MS = 700;

// ============= SCRAPING FUNCTIONS =============

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function absUrl(base: string, href: string) {
  if (href.startsWith("http")) return href;
  return new URL(href, base).toString();
}

function uniq<T>(arr: T[]) {
  return [...new Set(arr)];
}

function safeFilenameFromUrl(url: string) {
  return (
    url
      .replace(/^https?:\/\//, "")
      .replace(/[^\w]+/g, "__")
      .slice(0, 180) + ".html"
  );
}

async function fetchWithCache(url: string): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const fp = path.join(CACHE_DIR, safeFilenameFromUrl(url));

  try {
    const cached = await fs.readFile(fp, "utf8");
    console.log(`  cache hit: ${url}`);
    return cached;
  } catch {
    // cache miss
  }

  console.log(`  fetch: ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "hr,en;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${url}`);
  }

  const html = await res.text();
  await fs.writeFile(fp, html, "utf8");
  await sleep(SLEEP_MS);
  return html;
}

function extractDetailLinks(listHtml: string): string[] {
  const $ = cheerio.load(listHtml);

  const links = $("a[href]")
    .map((_, a) => String($(a).attr("href") || ""))
    .get()
    .filter((h) => h.includes("/zgrade/"))
    .map((h) => absUrl(LIST_URL, h))
    .map((u) => u.split("#")[0]);

  return uniq(links);
}

function parseDetail(detailHtml: string, url: string): RawBuilding {
  const $ = cheerio.load(detailHtml);

  const name = $("h3").first().text().trim() || null;
  const address = $("p.lead").first().text().trim() || null;
  const description_raw = $("article.my-4").first().text().trim() || null;

  let architects_raw: string | null = null;
  const architectLinks = $(
    "nav[aria-label='breadcrumb'] a[href^='/arhitekti/']:not([href='/arhitekti/'])"
  )
    .map((_, a) => $(a).text().trim())
    .get();

  if (architectLinks.length > 0) {
    architects_raw = architectLinks.join("; ");
  }

  let image_full_url: string | null = null;
  let image_thumb_url: string | null = null;

  const firstGalleryA = $("div.gallery a[href]").first();
  if (firstGalleryA.length) {
    const href = String(firstGalleryA.attr("href") || "").trim();
    if (href) image_full_url = absUrl(url, href);

    const imgSrc = String(firstGalleryA.find("img").attr("src") || "").trim();
    if (imgSrc) image_thumb_url = absUrl(url, imgSrc);
  }

  return {
    source: "arhitektura-zagreba",
    source_url: url,
    retrieved_at: nowIso(),
    name,
    address,
    architects_raw,
    description_raw,
    image_full_url,
    image_thumb_url,
    built_year: "Unknown",
  };
}

async function scrape(): Promise<RawBuilding[]> {
  console.log(`\n📥 SCRAPING: ${AREA_SLUG}`);
  console.log(`   List page: ${LIST_URL}`);
  console.log(`   Output: ${RAW_PATH}`);
  
  await fs.mkdir(path.dirname(RAW_PATH), { recursive: true });

  const listHtml = await fetchWithCache(LIST_URL);
  const detailUrls = extractDetailLinks(listHtml);

  console.log(`   Found ${detailUrls.length} building pages.`);
  if (detailUrls.length === 0) {
    console.log("   No building links found — aborting.");
    return [];
  }

  const records: RawBuilding[] = [];
  const outLines: string[] = [];

  for (let i = 0; i < detailUrls.length; i++) {
    const url = detailUrls[i];
    console.log(`   [${i + 1}/${detailUrls.length}] ${url}`);

    const html = await fetchWithCache(url);
    const rec = parseDetail(html, url);

    console.log(
      `     -> name=${rec.name ?? "null"} | address=${rec.address ?? "null"}`
    );

    records.push(rec);
    outLines.push(JSON.stringify(rec));
  }

  await fs.writeFile(RAW_PATH, outLines.join("\n") + "\n", "utf8");
  console.log(`   ✅ Wrote ${RAW_PATH} (${outLines.length} records)`);

  return records;
}

// ============= NORMALIZATION FUNCTIONS =============

function stripDiacritics(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slugify(s: string) {
  const noDia = stripDiacritics(s.toLowerCase());
  return noDia
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeWhitespace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function normalizeArchitects(raw: string | null) {
  const s = normalizeWhitespace(raw ?? "");
  if (!s) return "";

  const unified = s
    .replace(/\s*&\s*/g, "; ")
    .replace(/\s+and\s+/gi, "; ")
    .replace(/\s+i\s+/gi, "; ");

  const parts = unified
    .split(/[;,]/g)
    .map((p) => normalizeWhitespace(p))
    .filter(Boolean);

  const seen = new Set<string>();
  const uniqParts: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniqParts.push(p);
    }
  }

  return uniqParts.join("; ");
}

function normalizeAddress(rawAddr: string | null) {
  let a = normalizeWhitespace(rawAddr ?? "");
  if (!a) return "";

  const lower = a.toLowerCase();
  const hasZagreb = lower.includes("zagreb");
  const hasCroatia = lower.includes("croatia") || lower.includes("hrvatska");

  if (!hasZagreb && !hasCroatia) {
    a = `${a}, 10000 Zagreb, Croatia`;
  } else if (hasZagreb && !hasCroatia) {
    a = `${a}, Croatia`;
  }

  return a;
}

function parseStreetAndHouseNumber(addr: string): { street: string; house_number: string } {
  const core = normalizeWhitespace(addr.replace(/,\s*.*$/, ""));
  const m = core.match(/\b(\d+[A-Za-z]?)\b/);
  const house_number = m ? m[1] : "";

  if (!m || m.index == null) {
    return { street: core, house_number };
  }

  const street = normalizeWhitespace(core.slice(0, m.index)).replace(/[,\-–]+$/g, "").trim();
  return { street: street || core, house_number };
}

function expandAddressRange(rangeStr: string): string[] {
  const normalized = normalizeWhitespace(rangeStr);
  const dashPattern = /\s*[-\u2013\u2014]\s*/;
  const match = normalized.match(dashPattern);
  
  if (!match) return [normalized];
  
  const dashIndex = match.index!;
  const firstPart = normalizeWhitespace(normalized.slice(0, dashIndex));
  const secondPart = normalizeWhitespace(normalized.slice(dashIndex + match[0].length));
  
  if (!firstPart || !secondPart) return [normalized];
  
  const { street: firstStreet } = parseStreetAndHouseNumber(firstPart);
  const secondNumberMatch = secondPart.match(/^\s*(\d+[A-Za-z]?)\s*$/);
  
  if (secondNumberMatch) {
    const secondNumber = secondNumberMatch[1];
    const secondAddress = firstStreet ? `${firstStreet} ${secondNumber}` : secondNumber;
    return [firstPart, secondAddress];
  } else {
    const { street: secondStreet, house_number: secondNumber } = parseStreetAndHouseNumber(secondPart);
    
    if (!secondStreet || secondStreet.length < 3) {
      if (secondNumber && firstStreet) {
        return [firstPart, `${firstStreet} ${secondNumber}`];
      }
    }
    
    return [firstPart, secondPart];
  }
}

function splitMultiAddress(rawAddr: string) {
  const parts = rawAddr
    .split("/")
    .map((s) => normalizeWhitespace(s))
    .filter(Boolean);
  
  const expanded: string[] = [];
  for (const part of parts) {
    const hasDash = /\s*[-\u2013\u2014]\s*/.test(part);
    
    if (hasDash) {
      const rangeParts = expandAddressRange(part);
      expanded.push(...rangeParts);
    } else {
      expanded.push(part);
    }
  }
  
  return expanded;
}

function choosePrimaryAddressFromParts(parts: string[]): string {
  const withNumbers = parts.filter((p) => {
    const { house_number } = parseStreetAndHouseNumber(p);
    return house_number !== "";
  });

  if (withNumbers.length === 0) {
    return parts[0] ?? "";
  }

  const trgWithNumber = withNumbers.find((p) => /^trg\s/i.test(p));
  return trgWithNumber ?? withNumbers[0] ?? "";
}

function extractStreetAndNumber(address: string) {
  const primary = normalizeWhitespace(address.split("/")[0] ?? address);
  const m = primary.match(/\b(\d+[A-Za-z]?)\b/);
  const num = m ? m[1] : "";
  const streetPart = primary.replace(/,\s*.*$/, "");
  return { streetPart, num };
}

function makeStableId(name: string, address: string) {
  const n = slugify(name);
  const { streetPart, num } = extractStreetAndNumber(address);

  const streetSlug = slugify(streetPart);
  if (streetSlug && num) return `${n}-${streetSlug}-${slugify(num)}`;
  if (streetSlug) return `${n}-${streetSlug}`;
  return n;
}

async function normalize(raws: RawBuilding[]) {
  console.log(`\n📝 NORMALIZING: ${raws.length} records`);
  console.log(`   Output: ${OUT_CSV}`);

  await fs.mkdir(path.dirname(OUT_CSV), { recursive: true });
  await fs.mkdir("output", { recursive: true });

  const canonical: CanonicalRow[] = [];
  const addressToIds: Record<string, string[]> = {};
  const validationResults = [];

  let skippedIncomplete = 0;
  let processed = 0;

  for (const r of raws) {
    const name = normalizeWhitespace(r.name ?? "");
    const address_raw = normalizeWhitespace(r.address ?? "");
    const address = normalizeAddress(address_raw);
    const architects = normalizeArchitects(r.architects_raw);
    const description = normalizeWhitespace(r.description_raw ?? "");
    const source_url = r.source_url;

    const recordData = { name, address, architects, description, source_url };
    const validation = validateRawBuildingRecord(recordData);
    validationResults.push(validation);

    if (!name || !address) {
      skippedIncomplete++;
      continue;
    }

    const id = makeStableId(name, address);

    const addressPartsRaw = splitMultiAddress(address_raw || address);
    const primaryAddressRaw = choosePrimaryAddressFromParts(addressPartsRaw);

    const normalizedAddressParts = addressPartsRaw.map((p) => {
      const normalized = normalizeAddress(p);
      const { street, house_number } = parseStreetAndHouseNumber(p);
      return { raw: p, normalized, street, house_number };
    });

    const primary_address = normalizeAddress(primaryAddressRaw || address);
    const addresses_json = JSON.stringify(normalizedAddressParts);

    canonical.push({
      id,
      name,
      address,
      address_raw,
      primary_address,
      addresses_json,
      description: description || "(TODO) Add short description",
      architects: architects || "Unknown",
      source_url,
      image_full_url: r.image_full_url ?? "",
      image_thumb_url: r.image_thumb_url ?? "",
      built_year: r.built_year ?? "Unknown",
    });

    processed++;

    const addrKey = address.toLowerCase();
    addressToIds[addrKey] = addressToIds[addrKey] ?? [];
    addressToIds[addrKey].push(id);
  }

  const collisionCheck = detectIdCollisions(canonical);
  if (!collisionCheck.isValid) {
    console.warn("   ⚠️  ID collisions detected:", collisionCheck.metrics?.collisions);
    validationResults.push(collisionCheck);
  }

  const possibleDuplicates = Object.entries(addressToIds)
    .filter(([, ids]) => ids.length > 1)
    .map(([addr, ids]) => ({ address: addr, ids }));

  canonical.sort((a, b) => a.id.localeCompare(b.id));

  const outCsv = stringify(canonical, {
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
    ],
  });

  await fs.writeFile(OUT_CSV, outCsv, "utf8");
  await fs.writeFile(OUT_DUPE, JSON.stringify(possibleDuplicates, null, 2), "utf8");

  const validationReportPath = path.join("output", "normalization_validation.json");
  await writeValidationReport(validationReportPath, validationResults, "Data Normalization");

  console.log(`   ✅ Wrote ${OUT_CSV} (${canonical.length} rows)`);
  console.log(`   ✅ Wrote ${OUT_DUPE} (${possibleDuplicates.length} possible duplicate groups)`);
  console.log(`   📊 Processed: ${processed}, Skipped incomplete: ${skippedIncomplete}`);

  return { processed, skippedIncomplete, canonicalCount: canonical.length };
}

// ============= MAIN =============

async function main() {
  console.log(`\n🏗️  SCRAPE AND NORMALIZE: ${AREA_SLUG}`);
  console.log(`${"=".repeat(50)}`);

  const result = await withErrorHandling(async () => {
    // Step 1: Scrape
    const rawRecords = await scrape();
    
    if (rawRecords.length === 0) {
      console.log("\n❌ No records scraped, skipping normalization.");
      return { scraped: 0, processed: 0 };
    }

    // Step 2: Normalize
    const normResult = await normalize(rawRecords);

    console.log(`\n${"=".repeat(50)}`);
    console.log(`✅ COMPLETE: Scraped ${rawRecords.length} -> Normalized ${normResult.canonicalCount}`);

    return { scraped: rawRecords.length, ...normResult };
  }, "Scrape and normalize");

  if (!result.success) {
    console.error("❌ Failed:", result.errors);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ scrape_and_normalize failed:", e);
  process.exit(1);
});
