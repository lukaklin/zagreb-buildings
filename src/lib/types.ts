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
};

// Minimal shape of our GeoJSON feature properties
export type BuildingProperties = {
  id: string;
  name?: string;
  address?: string;
  description?: string;
  architects?: string[];
  sourceUrl?: string;

  imageThumbUrl?: string;
  imageFullUrl?: string;
  builtYear?: string;
};
