/**
 * Direct MOC (Ministry of Commerce, Thailand) price scraper for a single
 * product. Ported from backend/src/services/product-scraper.ts - kept
 * minimal (one product per call, no DB, no whitelist bookkeeping) since
 * this package has no backend import and no database of its own.
 *
 * data.moc.go.th has no plain CSV/API endpoint - a full browser is
 * required to render the search results and trigger the CSV export.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "./config.js";

const MIN_RECORDS_EXPECTED = 0; // any record is usable; staleness is checked by the caller

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

const randomUserAgent = () =>
  USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] as string;

const formatDate = (d: Date): string => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MocPriceRecord {
  date: string; // YYYY-MM-DD
  priceMax: number;
  priceMin: number;
}

export interface MocQuote {
  productCode: string;
  priceMin: number;
  priceMax: number;
  date: string; // ISO 8601
}

/**
 * Parse a CSV line that may contain quoted fields.
 * Handles: field,"field with, comma",field
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

// CSV header: รหัสสินค้า,ชื่อสินค้า,หมวดหมู่สินค้า,กลุ่มสินค้า,วันที่สำรวจ,ราคาสูงสุด,ราคาต่ำสุด
function parseDownloadedCsv(content: string): MocPriceRecord[] {
  const rawLines = content.split("\n");
  const records: MocPriceRecord[] = [];

  let i = 1; // skip header
  while (i < rawLines.length) {
    let line = rawLines[i] || "";

    // Embedded newline in product name continues onto the next line, which
    // starts with a bare comma.
    while (i + 1 < rawLines.length && rawLines[i + 1]?.startsWith(",")) {
      i++;
      line += rawLines[i];
    }

    line = line.trim();
    if (!line) {
      i++;
      continue;
    }

    const fields = parseCsvLine(line);

    let priceMin: number;
    let priceMax: number;
    let dateStr: string;

    if (fields.length === 7) {
      dateStr = fields[4] || "";
      priceMax = Number.parseFloat(fields[5] || "0");
      priceMin = Number.parseFloat(fields[6] || "0");
    } else if (fields.length > 7) {
      // Malformed CSV with commas in the product name - parse from the end.
      priceMin = Number.parseFloat(fields[fields.length - 1] || "0");
      priceMax = Number.parseFloat(fields[fields.length - 2] || "0");
      dateStr = fields[fields.length - 3] || "";
    } else {
      i++;
      continue;
    }

    const datePart = dateStr.split(" ")[0] || "";
    const dateParts = datePart.split("/");
    if (dateParts.length !== 3) {
      i++;
      continue;
    }

    const [month, day, year] = dateParts.map(Number);
    if (!month || !day || !year) {
      i++;
      continue;
    }

    records.push({
      date: formatDate(new Date(Date.UTC(year, month - 1, day))),
      priceMax,
      priceMin,
    });

    i++;
  }

  return records;
}

async function scrapeOnce(productCode: string): Promise<MocQuote> {
  const config = loadConfig();
  const toDate = formatDate(new Date());
  const to = new Date(toDate);
  const fromDate = formatDate(new Date(to.getFullYear(), to.getMonth() - 1, 1));
  const searchUrl = `${config.mocBaseUrl}?product_id=${productCode}&from_date=${fromDate}&to_date=${toDate}&task=search`;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1280, height: 800 },
      locale: "th-TH",
      timezoneId: "Asia/Bangkok",
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();
    try {
      await page.goto(searchUrl, {
        timeout: config.mocRequestTimeoutMs,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle").catch(() => {});

      const hasData = await page
        .locator('h5:has-text("ผลการค้นหา")')
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

      if (!hasData) {
        throw new Error(`MOC returned no results for product ${productCode}`);
      }

      const downloadPromise = page.waitForEvent("download", {
        timeout: config.mocRequestTimeoutMs,
      });
      void downloadPromise.catch(() => {});

      await page.click('a[href="javascript:exportAsCSV();"]');
      const download = await downloadPromise;

      const csvPath = path.join(
        await fs.promises.mkdtemp(path.join(os.tmpdir(), "moc-")),
        `${productCode}.csv`,
      );
      await download.saveAs(csvPath);
      const content = await fs.promises.readFile(csvPath, "utf-8");
      await fs.promises.unlink(csvPath).catch(() => {});

      const records = parseDownloadedCsv(content);
      if (records.length <= MIN_RECORDS_EXPECTED) {
        throw new Error(`MOC CSV for ${productCode} had no parseable rows`);
      }

      const latest = records.reduce((a, b) => (a.date > b.date ? a : b));
      return {
        productCode,
        priceMin: latest.priceMin,
        priceMax: latest.priceMax,
        date: `${latest.date}T00:00:00Z`,
      };
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Scrapes the latest MOC price for a single product, retrying transient
 * timeouts. Throws if every attempt fails - the caller (price-source.ts)
 * is responsible for falling back to the backend price feed.
 */
export async function scrapeMocProduct(productCode: string): Promise<MocQuote> {
  const config = loadConfig();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= config.mocScrapeAttempts; attempt++) {
    try {
      return await scrapeOnce(productCode);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < config.mocScrapeAttempts) {
        console.warn(
          `[moc-scraper] ${productCode} attempt ${attempt}/${config.mocScrapeAttempts} failed (${lastError.message}); retrying`,
        );
        await sleep(2000 + Math.random() * 3000);
      }
    }
  }

  throw lastError ?? new Error(`MOC scrape failed for ${productCode}`);
}
