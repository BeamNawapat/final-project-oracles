import { loadConfig } from "./config.js";

/**
 * Expected shape of a price quote from PRICE_SOURCE_URL. This repo does not
 * ship a price server - point PRICE_SOURCE_URL at any endpoint (your own
 * scraper, a public commodity price API, etc.) that returns this shape for
 * `GET {PRICE_SOURCE_URL}?productCode=<code>`:
 *
 *   { "productCode": "RICE-WHITE", "priceMin": 12.5, "priceMax": 13.1, "date": "2026-07-03T00:00:00Z" }
 *
 * priceMin/priceMax are decimal units (e.g. THB/kg), NOT scaled - this
 * module does the 6-decimal scaling to match the contract's fixed-point
 * convention (see AgriOracle.sol submitReport: avgPrice = (priceMin +
 * priceMax) / 2, all stored as uint256 with 6 decimals of precision).
 */
interface PriceQuote {
  productCode: string;
  priceMin: number;
  priceMax: number;
  date: string;
}

export interface ScaledPrice {
  priceMin: bigint;
  priceMax: bigint;
  sourceDate: bigint;
}

const PRICE_SCALE = 1_000_000n; // 6 decimals, matches submitReport's fixed-point convention

function toScaledUnits(value: number): bigint {
  return BigInt(Math.round(value * Number(PRICE_SCALE)));
}

export class StalePriceError extends Error {}

/**
 * Fetches the current reference price for `productCode` from PRICE_SOURCE_URL
 * and scales it to 6 decimals. Throws StalePriceError if the source's data
 * is older than STALE_PRICE_HOURS - the contract itself also rejects a
 * sourceDate older than MAX_SOURCE_DATE_AGE (3 days), but the reporter's own
 * staleness window should be tighter so it doesn't sign data nobody wants.
 */
export async function fetchScaledPrice(productCode: string): Promise<ScaledPrice> {
  const config = loadConfig();
  if (!config.priceSourceUrl) {
    throw new Error("PRICE_SOURCE_URL is not set - see .env.example");
  }

  const url = new URL(config.priceSourceUrl);
  url.searchParams.set("productCode", productCode);

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Price source returned ${res.status} for ${productCode}`);
  }

  const quote = (await res.json()) as PriceQuote;
  if (!quote || typeof quote.priceMin !== "number" || typeof quote.priceMax !== "number" || !quote.date) {
    throw new Error(`Price source returned an unexpected shape for ${productCode}: ${JSON.stringify(quote)}`);
  }

  const sourceDateMs = new Date(quote.date).getTime();
  if (Number.isNaN(sourceDateMs)) {
    throw new Error(`Price source returned an unparseable date for ${productCode}: "${quote.date}"`);
  }

  const ageMs = Date.now() - sourceDateMs;
  if (ageMs > config.staleThresholdMs) {
    throw new StalePriceError(
      `Price for ${productCode} is ${Math.round(ageMs / 3_600_000)}h old, ` +
        `older than STALE_PRICE_HOURS (${config.staleThresholdMs / 3_600_000}h)`,
    );
  }
  if (sourceDateMs > Date.now()) {
    throw new Error(`Price source returned a future date for ${productCode}: "${quote.date}"`);
  }

  return {
    priceMin: toScaledUnits(quote.priceMin),
    priceMax: toScaledUnits(quote.priceMax),
    sourceDate: BigInt(Math.floor(sourceDateMs / 1000)),
  };
}
