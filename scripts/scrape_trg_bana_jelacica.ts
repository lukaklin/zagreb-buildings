// scripts/scrape_trg_bana_jelacica.ts

import { promises as fs } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

const LIST_URL = "https://www.arhitektura-zagreba.com/ulice/trg-bana-jelacica";
const OUT_PATH = path.join(
  "input",
  "raw",
  "arhitektura-zagreba.trg-bana-jelacica.jsonl"
);
const CACHE_DIR = path.join("cache", "html");

const USER_AGENT =
  "zagreb-buildings-info-app/0.1 (contact: lukaklincic@hotmail.com)";
const SLEEP_MS = 700;

type RawBuilding = {
  source: string;
  source_url: string;
  retrieved_at: string;

  name: string | null;
  address: string | null;
  architects_raw: string | null;
  description_raw: string | null;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function absUrl(base: string, href: string) {
  if (href.startsWith("http")) return href;
  return new URL(href, base).toString();
}

function uniq<T>(arr: T[]) {
  return [...new Set(arr)];
}

function safeFilenameFromUrl(url: string) {
  return (
    url
      .replace(/^https?:\/\//, "")
      .replace(/[^\w]+/g, "__")
      .slice(0, 180) + ".html"
  );
}

async function fetchWithCache(url: string): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const fp = path.join(CACHE_DIR, safeFilenameFromUrl(url));

  try {
    const cached = await fs.readFile(fp, "utf8");
    console.log(`  cache hit: ${url}`);
    return cached;
  } catch {
    // cache miss
  }

  console.log(`  fetch: ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "hr,en;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${url}`);
  }

  const html = await res.text();
  await fs.writeFile(fp, html, "utf8");
  await sleep(SLEEP_MS);
  return html;
}

function extractDetailLinks(listHtml: string): string[] {
  const $ = cheerio.load(listHtml);

  const links = $("a[href]")
    .map((_, a) => String($(a).attr("href") || ""))
    .get()
    .filter((h) => h.includes("/zgrade/"))
    .map((h) => absUrl(LIST_URL, h))
    .map((u) => u.split("#")[0]);

  return uniq(links);
}

function parseDetail(detailHtml: string, url: string): RawBuilding {
  const $ = cheerio.load(detailHtml);

  // 1) Name
  const name = $("h3").first().text().trim() || null;

  // 2) Address
  const address = $("p.lead").first().text().trim() || null;

  // 3) Description
  const description_raw = $("article.my-4").first().text().trim() || null;

  // 4) Architects (breadcrumb after "Arhitekti")
  let architects_raw: string | null = null;
  const architectLinks = $("nav[aria-label='breadcrumb'] a[href^='/arhitekti/']:not([href='/arhitekti/'])")
    .map((_, a) => $(a).text().trim())
    .get();

  if (architectLinks.length > 0) {
    architects_raw = architectLinks.join("; ");
  }

  return {
    source: "arhitektura-zagreba",
    source_url: url,
    retrieved_at: nowIso(),
    name,
    address,
    architects_raw,
    description_raw,
  };
}

async function main() {
  console.log(`Scraping list page: ${LIST_URL}`);
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });

  const listHtml = await fetchWithCache(LIST_URL);
  const detailUrls = extractDetailLinks(listHtml);

  console.log(`Found ${detailUrls.length} building pages.`);
  if (detailUrls.length === 0) {
    console.log("No building links found — aborting.");
    return;
  }

  const outLines: string[] = [];

  for (let i = 0; i < detailUrls.length; i++) {
    const url = detailUrls[i];
    console.log(`\n[${i + 1}/${detailUrls.length}] ${url}`);

    const html = await fetchWithCache(url);
    const rec = parseDetail(html, url);

    console.log(
      `  -> name=${rec.name ?? "null"} | address=${rec.address ?? "null"} | architects=${rec.architects_raw ?? "null"} | desc=${rec.description_raw ? rec.description_raw.length + " chars" : "null"}`
    );

    outLines.push(JSON.stringify(rec));
  }

  await fs.writeFile(OUT_PATH, outLines.join("\n") + "\n", "utf8");
  console.log(`\n✅ Wrote ${OUT_PATH} (${outLines.length} records)`);
}

main().catch((err) => {
  console.error("❌ scrape failed:", err);
  process.exit(1);
});
