import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";

type RawBuilding = {
  source: string;
  source_url: string;
  retrieved_at: string;

  name: string | null;
  address: string | null;
  architects_raw: string | null;
  description_raw: string | null;
};

type CanonicalRow = {
  id: string;
  name: string;
  address: string;
  description: string;
  architects: string;
  source_url: string;
};

const IN_PATH = path.join("input", "raw", "arhitektura-zagreba.trg-bana-jelacica.jsonl");
const OUT_CSV = path.join("input", "canonical", "buildings_canonical.csv");
const OUT_DUPE = path.join("output", "possible_duplicates.json");

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
  await fs.mkdir(path.dirname(OUT_CSV), { recursive: true });
  await fs.mkdir("output", { recursive: true });

  const rawText = await fs.readFile(IN_PATH, "utf8");
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

  const raws: RawBuilding[] = lines.map((l) => JSON.parse(l));

  const canonical: CanonicalRow[] = [];
  const addressToIds: Record<string, string[]> = {};

  for (const r of raws) {
    const name = normalizeWhitespace(r.name ?? "");
    const address = normalizeAddress(r.address);
    const architects = normalizeArchitects(r.architects_raw);
    const description = normalizeWhitespace(r.description_raw ?? "");
    const source_url = r.source_url;

    if (!name || !address) {
      // Skip incomplete rows; raw stays preserved in JSONL anyway
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
    });

    const addrKey = address.toLowerCase();
    addressToIds[addrKey] = addressToIds[addrKey] ?? [];
    addressToIds[addrKey].push(id);
  }

  // Find possible duplicates by identical normalized address
  const possibleDuplicates = Object.entries(addressToIds)
    .filter(([, ids]) => ids.length > 1)
    .map(([addr, ids]) => ({ address: addr, ids }));

  // Sort for stable diffs
  canonical.sort((a, b) => a.id.localeCompare(b.id));

  const outCsv = stringify(canonical, {
    header: true,
    columns: ["id", "name", "address", "description", "architects", "source_url"],
  });

  await fs.writeFile(OUT_CSV, outCsv, "utf8");
  await fs.writeFile(OUT_DUPE, JSON.stringify(possibleDuplicates, null, 2), "utf8");

  console.log(`✅ Wrote ${OUT_CSV} (${canonical.length} rows)`);
  console.log(`✅ Wrote ${OUT_DUPE} (${possibleDuplicates.length} possible duplicate groups)`);
}

main().catch((e) => {
  console.error("❌ normalize failed:", e);
  process.exit(1);
});
