import { execSync } from "node:child_process";

// Accept area slugs as command line arguments
const areaSlugs = process.argv.slice(2);

if (areaSlugs.length === 0) {
  console.log("Usage: npm run rebuild:combined -- <area1> <area2> ...");
  console.log("Example: npm run rebuild:combined -- trg-bana-jelacica trg-zrtava-fasizma");
  process.exit(1);
}

console.log(`🔨 Rebuilding combined dataset from areas: ${areaSlugs.join(", ")}`);

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
