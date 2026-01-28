// Shared types for script files

export type RawBuilding = {
  source: string;
  source_url: string;
  retrieved_at: string;

  name: string | null;
  address: string | null;
  architects_raw: string | null;
  description_raw: string | null;

  image_full_url: string | null;
  image_thumb_url: string | null;
  built_year: "Unknown";
};

export type NormalizedAddressPart = {
  raw: string;
  normalized: string;
  street: string;
  house_number: string;
};

export type CanonicalRow = {
  id: string;
  name: string;
  address: string;
  // Added for stable geocoding + matching (kept optional for backward compatibility)
  address_raw?: string;
  primary_address?: string;
  addresses_json?: string; // JSON string of NormalizedAddressPart[]
  description: string;
  architects: string;
  source_url: string;

  image_full_url: string;
  image_thumb_url: string;
  built_year: string;
};
