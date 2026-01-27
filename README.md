# Zagreb Buildings

An interactive map app for exploring notable buildings in Zagreb (with an initial focus on Donji grad), showing building footprints and metadata.

This is a [Next.js](https://nextjs.org) project bootstrapped with
[`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

---

## Tech stack
- Next.js (App Router)
- TypeScript
- Tailwind CSS
- MapLibre GL
- GeoJSON / OSM-derived building data

---

## Adding New Areas

The scraper is now configurable to add buildings from any area on [arhitektura-zagreba.com](https://www.arhitektura-zagreba.com).

### Quick Start for New Area

1. **Scrape the area:**
   ```bash
   npm run scrape:area <area-slug>
   ```
   Example: `npm run scrape:area trg-zrtava-fasizma`

2. **Normalize the data:**
   ```bash
   npm run normalize:area <area-slug>
   ```

3. **Combine with existing areas (optional):**
   ```bash
   npm run combine:areas <area1> <area2> ...
   ```

4. **Run the full pipeline:**
   ```bash
   npm run pipeline:area <area-slug>
   ```

### Available Areas

- `trg-bana-jelacica` - Main square (default)
- `trg-zrtava-fasizma` - Square of Victims of Fascism

### Convenience Scripts

```bash
# Process a new area end-to-end
npm run process:area <area-slug>

# Rebuild combined dataset with all areas
npm run rebuild:combined
```

---

## Getting Started

First, install dependencies:

```bash
npm install
