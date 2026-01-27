import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import {
  validateRawBuildingRecord,
  detectIdCollisions,
  withErrorHandling,
  writeValidationReport
} from "./validation.ts";

type RawBuilding = {
  source: string;
  source_url: string;
  retrieved_at: string;

  name: string | null;
  address: string | null;
  architects_raw: string | null;
  description_raw: string | null;

  image_full_url: string | null;
  image_thumb_url: string | null;
  built_year: "Unknown";
};

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


// Accept area as command line argument, default to trg-bana-jelacica for backward compatibility
const AREA_SLUG = process.argv[2] || "trg-bana-jelacica";

const IN_PATH = path.join("input", "raw", `arhitektura-zagreba.${AREA_SLUG}.jsonl`);
const OUT_CSV = path.join("input", "canonical", `buildings_${AREA_SLUG}_canonical.csv`);
const OUT_DUPE = path.join("output", `possible_duplicates_${AREA_SLUG}.json`);

function stripDiacritics(s: string) {
  // Unicode normalize + remove diacritic marks
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

  // Replace common conjunctions with separators
  const unified = s
    .replace(/\s*&\s*/g, "; ")
    .replace(/\s+and\s+/gi, "; ")
    .replace(/\s+i\s+/gi, "; "); // Croatian "and"

  // Split on comma or semicolon, rejoin with "; "
  const parts = unified
    .split(/[;,]/g)
    .map((p) => normalizeWhitespace(p))
    .filter(Boolean);

  // Deduplicate preserving order
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(p);
    }
  }

  return uniq.join("; ");
}

function normalizeAddress(rawAddr: string | null) {
  let a = normalizeWhitespace(rawAddr ?? "");
  if (!a) return "";

  // Make geocoder happier: ensure "Zagreb, Croatia" suffix exists
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

function extractStreetAndNumber(address: string) {
  // Best-effort: take the first segment before "/" for slugging
  const primary = normalizeWhitespace(address.split("/")[0] ?? address);

  // Try to grab a number token
  const m = primary.match(/\b(\d+[A-Za-z]?)\b/);
  const num = m ? m[1] : "";

  // Remove commas/city info for street part
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

async function main() {
  const result = await withErrorHandling(async () => {
    await fs.mkdir(path.dirname(OUT_CSV), { recursive: true });
    await fs.mkdir("output", { recursive: true });

    const rawText = await fs.readFile(IN_PATH, "utf8");
    const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

    const raws: RawBuilding[] = lines.map((l) => JSON.parse(l));

    console.log(`📊 Processing ${raws.length} raw building records for area: ${AREA_SLUG}`);
    console.log(`   Input: ${IN_PATH}`);
    console.log(`   Output: ${OUT_CSV}`);

    const canonical: CanonicalRow[] = [];
    const addressToIds: Record<string, string[]> = {};
    const validationResults = [];

    let skippedIncomplete = 0;
    let processed = 0;

    for (const r of raws) {
      const name = normalizeWhitespace(r.name ?? "");
      const address = normalizeAddress(r.address);
      const architects = normalizeArchitects(r.architects_raw);
      const description = normalizeWhitespace(r.description_raw ?? "");
      const source_url = r.source_url;

      // Validate record completeness (before ID generation)
      const recordData = { name, address, architects, description, source_url };
      const validation = validateRawBuildingRecord(recordData);
      validationResults.push(validation);

      if (!name || !address) {
        skippedIncomplete++;
        continue;
      }

      const id = makeStableId(name, address);

      canonical.push({
        id,
        name,
        address,
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

    // Check for ID collisions
    const collisionCheck = detectIdCollisions(canonical);
    if (!collisionCheck.isValid) {
      console.warn("⚠️  ID collisions detected:", collisionCheck.metrics?.collisions);
      // For now, continue but log the issue
      validationResults.push(collisionCheck);
    }

    // Find possible duplicates by identical normalized address
    const possibleDuplicates = Object.entries(addressToIds)
      .filter(([, ids]) => ids.length > 1)
      .map(([addr, ids]) => ({ address: addr, ids }));

    // Sort for stable diffs
    canonical.sort((a, b) => a.id.localeCompare(b.id));

    const outCsv = stringify(canonical, {
      header: true,
      columns: [
        "id",
        "name",
        "address",
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

    // Write validation report
    const validationReportPath = path.join("output", "normalization_validation.json");
    await writeValidationReport(validationReportPath, validationResults, "Data Normalization");

    console.log(`✅ Wrote ${OUT_CSV} (${canonical.length} rows)`);
    console.log(`✅ Wrote ${OUT_DUPE} (${possibleDuplicates.length} possible duplicate groups)`);
    console.log(`📊 Processed: ${processed}, Skipped incomplete: ${skippedIncomplete}`);

    return {
      processed,
      skippedIncomplete,
      canonicalCount: canonical.length,
      duplicatesCount: possibleDuplicates.length
    };

  }, "Data normalization");

  if (!result.success) {
    console.error("❌ Normalization failed with errors:", result.errors);
    process.exit(1);
  }
}

// Main execution with error handling
main().catch((e) => {
  console.error("❌ normalize failed:", e);
  process.exit(1);
});
