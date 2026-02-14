import type { BuildingFeature } from "./types";

/**
 * Strip diacritics and lowercase a string so that e.g.
 * "Meštrović" matches a query of "mestrovic".
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Search buildings by matching `query` against name, address and architects.
 * Returns at most `limit` results (default 10).
 */
export function searchBuildings(
  buildings: BuildingFeature[],
  query: string,
  limit = 10,
): BuildingFeature[] {
  const q = normalizeText(query.trim());
  if (!q) return [];

  return buildings
    .filter((f) => {
      const p = f.properties;
      if (p.name && normalizeText(p.name).includes(q)) return true;
      if (p.address && normalizeText(p.address).includes(q)) return true;
      if (
        p.architects?.some((a) => normalizeText(a).includes(q))
      )
        return true;
      return false;
    })
    .slice(0, limit);
}
