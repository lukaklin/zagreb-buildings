import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

// Auto-discover areas from raw input files
function discoverAreas(): string[] {
  const rawDir = path.join("input", "raw");
  const files = readdirSync(rawDir);

  return files
    .filter((f) => f.startsWith("arhitektura-zagreba.") && f.endsWith(".jsonl"))
    .map((f) => f.replace("arhitektura-zagreba.", "").replace(".jsonl", ""))
    .sort();
}

// Use provided args, or auto-discover if none given
const providedAreas = process.argv.slice(2);
const areaSlugs = providedAreas.length > 0 ? providedAreas : discoverAreas();

if (areaSlugs.length === 0) {
  console.log("No areas found. Either:");
  console.log("  - Add raw files to input/raw/ (arhitektura-zagreba.<area>.jsonl)");
  console.log("  - Or specify areas manually: npm run rebuild:combined -- <area1> <area2>");
  process.exit(1);
}

const source = providedAreas.length > 0 ? "specified" : "auto-discovered";
console.log(`🔨 Rebuilding combined dataset from ${areaSlugs.length} ${source} areas:`);
console.log(`   ${areaSlugs.join(", ")}`);

try {
  // Step 1: Combine areas
  console.log("\n📦 Step 1: Combining areas...");
  execSync(`npm run combine:areas -- ${areaSlugs.join(" ")}`, { stdio: "inherit" });

  // Step 2: Run the pipeline (geocode → footprints → geojson)
  console.log("\n🔄 Step 2: Running pipeline (geocode → footprints → geojson)...");
  execSync("npm run pipeline", { stdio: "inherit" });

  console.log("\n✅ Rebuild complete!");
} catch (error) {
  console.error("\n❌ Rebuild failed:", error);
  process.exit(1);
}
