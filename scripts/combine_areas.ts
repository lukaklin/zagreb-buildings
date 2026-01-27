import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { detectIdCollisions, withErrorHandling } from "./validation.ts";

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

// Accept area slugs as command line arguments
const areaSlugs = process.argv.slice(2);

if (areaSlugs.length === 0) {
  console.log("Usage: npm run combine:areas <area1> <area2> ...");
  console.log("Example: npm run combine:areas trg-bana-jelacica trg-zrtava-fasizma");
  process.exit(1);
}

const CANONICAL_DIR = path.join("input", "canonical");
const OUTPUT_COMBINED = path.join("input", "canonical", "buildings_combined_canonical.csv");

async function combineCanonicalFiles(areaSlugs: string[]): Promise<CanonicalRow[]> {
  const allRows: CanonicalRow[] = [];

  for (const areaSlug of areaSlugs) {
    const canonicalPath = path.join(CANONICAL_DIR, `buildings_${areaSlug}_canonical.csv`);

    try {
      const csvText = await fs.readFile(canonicalPath, "utf8");
      const rows = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as CanonicalRow[];

      console.log(`📄 Loaded ${rows.length} buildings from ${areaSlug}`);
      allRows.push(...rows);
    } catch (error) {
      console.warn(`⚠️  Could not load ${canonicalPath}:`, error);
    }
  }

  return allRows;
}

async function main() {
  const result = await withErrorHandling(async () => {
    console.log(`🔗 Combining areas: ${areaSlugs.join(", ")}`);

    const allRows = await combineCanonicalFiles(areaSlugs);

    if (allRows.length === 0) {
      throw new Error("No canonical files found or all were empty");
    }

    // Check for ID collisions across all areas
    const collisionCheck = detectIdCollisions(allRows);
    if (!collisionCheck.isValid) {
      console.warn("⚠️  ID collisions detected across combined areas:");
      collisionCheck.metrics?.collisions?.forEach((collision: any) => {
        console.warn(`   - ID "${collision.id}" used by ${collision.records.length} buildings`);
        collision.records.forEach((record: any) => {
          console.warn(`     * ${record.name} (${record.address})`);
        });
      });

      // For now, continue but log the issue
      // In the future, you might want to prefix IDs with area slugs to avoid collisions
    }

    // Sort by ID for consistent output
    allRows.sort((a, b) => a.id.localeCompare(b.id));

    const csvOutput = stringify(allRows, {
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

    await fs.writeFile(OUTPUT_COMBINED, csvOutput, "utf8");

    console.log(`✅ Combined ${allRows.length} buildings from ${areaSlugs.length} areas`);
    console.log(`📄 Output: ${OUTPUT_COMBINED}`);

    return {
      totalBuildings: allRows.length,
      areasCombined: areaSlugs.length,
      idCollisions: collisionCheck.metrics?.collisions?.length || 0
    };

  }, "Area combination");

  if (!result.success) {
    console.error("❌ Area combination failed:", result.errors);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ combine_areas failed:", err);
  process.exit(1);
});