export type Building = {
    id: string;
    name?: string | null;
    address?: string | null;
    description?: string | null;
    architects?: string[] | null;
    sourceUrl?: string | null;
  };
  
  // Minimal shape of our GeoJSON feature properties
  export type BuildingProperties = {
    id: string;
    name?: string;
    address?: string;
    description?: string;
    architects?: string[];
    sourceUrl?: string;
  };
  