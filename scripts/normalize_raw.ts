import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import {
  validateRawBuildingRecord,
  detectIdCollisions,
  withErrorHandling,
  writeValidationReport
} from "./validation";
import type { RawBuilding, CanonicalRow } from "./types";


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

/**
 * Expands an address range into endpoints only.
 * Handles patterns like "Trg bana Jelačića 10A - 10" or "Jurišićeva 1-4"
 * Returns only endpoints, not expanded numeric ranges.
 */
function expandAddressRange(rangeStr: string): string[] {
  const normalized = normalizeWhitespace(rangeStr);
  
  // Match dash separators: " - " (with spaces), "-" (without spaces), " – " (en-dash), " — " (em-dash)
  const dashPattern = /\s*[-\u2013\u2014]\s*/;
  const match = normalized.match(dashPattern);
  
  if (!match) {
    // No dash found, return as-is
    return [normalized];
  }
  
  const dashIndex = match.index!;
  const firstPart = normalizeWhitespace(normalized.slice(0, dashIndex));
  const secondPart = normalizeWhitespace(normalized.slice(dashIndex + match[0].length));
  
  if (!firstPart || !secondPart) {
    // Invalid range, return as-is
    return [normalized];
  }
  
  // Extract street and house number from first part
  const { street: firstStreet, house_number: firstNumber } = parseStreetAndHouseNumber(firstPart);
  
  // Check if second part is just a number/house number (no street name)
  const secondNumberMatch = secondPart.match(/^\s*(\d+[A-Za-z]?)\s*$/);
  
  if (secondNumberMatch) {
    // Second part is just a number, prepend the street from first part
    const secondNumber = secondNumberMatch[1];
    const secondAddress = firstStreet ? `${firstStreet} ${secondNumber}` : secondNumber;
    
    // Return endpoints only (do not expand numeric ranges)
    return [firstPart, secondAddress];
  } else {
    // Second part already contains a street name, use as-is
    // Extract street from second part to verify
    const { street: secondStreet } = parseStreetAndHouseNumber(secondPart);
    
    if (!secondStreet || secondStreet.length < 3) {
      // Second part doesn't look like a full address, try prepending first street
      const { house_number: secondNumber } = parseStreetAndHouseNumber(secondPart);
      if (secondNumber && firstStreet) {
        return [firstPart, `${firstStreet} ${secondNumber}`];
      }
    }
    
    // Both parts are full addresses
    return [firstPart, secondPart];
  }
}

function splitMultiAddress(rawAddr: string) {
  // First split on "/" to separate different streets
  const parts = rawAddr
    .split("/")
    .map((s) => normalizeWhitespace(s))
    .filter(Boolean);
  
  // Expand any dash-separated ranges in each part
  const expanded: string[] = [];
  for (const part of parts) {
    // Check if part contains a dash separator
    const hasDash = /\s*[-\u2013\u2014]\s*/.test(part);
    
    if (hasDash) {
      // Expand the range (returns endpoints only)
      const rangeParts = expandAddressRange(part);
      expanded.push(...rangeParts);
    } else {
      // No dash, add as-is
      expanded.push(part);
    }
  }
  
  return expanded;
}

function choosePrimaryAddressFromParts(parts: string[]): string {
  // Parse each part to check for house numbers
  const withNumbers = parts.filter((p) => {
    const { house_number } = parseStreetAndHouseNumber(p);
    return house_number !== "";
  });

  if (withNumbers.length === 0) {
    // No addresses have house numbers, fallback to first
    return parts[0] ?? "";
  }

  // Among addresses with numbers, prefer ones starting with "Trg"
  const trgWithNumber = withNumbers.find((p) => /^trg\s/i.test(p));
  return trgWithNumber ?? withNumbers[0] ?? "";
}

function parseStreetAndHouseNumber(addr: string): { street: string; house_number: string } {
  // Strip trailing city/postcode/country
  const core = normalizeWhitespace(addr.replace(/,\s*.*$/, ""));
  const m = core.match(/\b(\d+[A-Za-z]?)\b/);
  const house_number = m ? m[1] : "";

  if (!m || m.index == null) {
    return { street: core, house_number };
  }

  const street = normalizeWhitespace(core.slice(0, m.index)).replace(/[,\-–]+$/g, "").trim();
  return { street: street || core, house_number };
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
      const address_raw = normalizeWhitespace(r.address ?? "");
      const address = normalizeAddress(address_raw);
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
