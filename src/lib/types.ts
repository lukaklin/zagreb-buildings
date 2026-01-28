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
