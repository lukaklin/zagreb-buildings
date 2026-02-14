export type Building = {
  id: string;
  name?: string | null;
  address?: string | null;
  description?: string | null;
  architects?: string[] | null;
  sourceUrl?: string | null;

  imageThumbUrl?: string | null;
  imageFullUrl?: string | null;
  builtYear?: string | null; // "Unknown" for now

  lat?: number | null;
  lon?: number | null;
};

/** A GeoJSON Feature whose properties match our Building type. */
export type BuildingFeature = GeoJSON.Feature<GeoJSON.Geometry, Building>;
