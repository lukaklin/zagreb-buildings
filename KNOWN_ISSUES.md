# Known Issues

Issues to address in future iterations. Some may require OSM edits.

## Shared Footprints

Buildings that share the same OSM polygon (separate historic buildings merged in OSM):

| Buildings | OSM Way | Notes |
|-----------|---------|-------|
| Gajeva 27, Gajeva 29 | `way/249753111` | Two buildings share one footprint |
| Gajeva 31, Gajeva 33 | `way/249205168` | Two buildings share one footprint |
| Trg Ante Starčevića 3, Trg Ante Starčevića 4 | `way/173430370` | Two buildings share one footprint |
| Mihanovićeva 16, Mihanovićeva 18 | `way/248696667` | Two buildings share one footprint |

**Potential fix**: Edit OSM to split these into separate building polygons.

## Duplicate Entries

Buildings scraped multiple times from different street pages:

| Building | Source Pages |
|----------|--------------|
| Hotel Milinov/Hotel Dubrovnik (Gajeva 1 / Trg bana Jelačića 16) | gajeva, trg-bana-jelacica |

**Potential fix**: Improve deduplication in `combine_areas.ts`.

## Geocoding Edge Cases

| Building | Issue | Resolution |
|----------|-------|------------|
| Kuća Betelheim (Praška 10 / Teslina 2) | "Teslina 2" doesn't exist in OSM | Added override to `way/584458872` |

---

*Last updated: 2026-02-04*
