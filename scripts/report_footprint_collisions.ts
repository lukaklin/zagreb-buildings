import { promises as fs } from "node:fs";

type GeometryPick = {
  osm_ref: string;
  geometry: any;
};

async function main() {
  const geomMap = JSON.parse(await fs.readFile("output/geometries.json", "utf8")) as Record<
    string,
    GeometryPick
  >;

  const byOsm: Record<string, string[]> = {};

  for (const [buildingId, pick] of Object.entries(geomMap)) {
    const key = pick?.osm_ref || "missing-osm-ref";
    byOsm[key] = byOsm[key] ?? [];
    byOsm[key].push(buildingId);
  }

  const collisions = Object.entries(byOsm)
    .filter(([, ids]) => ids.length > 1)
    .map(([osm, ids]) => ({ osm, count: ids.length, ids }))
    .sort((a, b) => b.count - a.count);

  console.log(JSON.stringify(collisions, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
