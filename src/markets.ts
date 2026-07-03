import { loadConfig } from "./config.js";

/**
 * Expected shape of MARKETS_API_URL's response - a public, read-only feed
 * of markets that are open for oracle reporting. This repo does not ship
 * that endpoint; point it at a project-hosted feed (or a subgraph over the
 * factory's MarketRegistered events) that returns:
 *
 *   [{ "questionId": "0x...", "productCode": "RICE-WHITE", "resolutionTime": "2026-07-03T12:00:00Z" }, ...]
 *
 * This is deliberately NOT a database query - a reporter node must not
 * depend on any single operator's private infrastructure to know what to
 * report on.
 */
export interface ReportableMarket {
  questionId: `0x${string}`;
  productCode: string;
  resolutionTime: string;
}

/**
 * Fetches the open-market list and returns only markets whose resolutionTime
 * has already passed (i.e. reporting should be active). Markets scheduled in
 * the future are filtered out here rather than by the caller, since "is this
 * market reportable yet" is a property of the feed's own clock, not ours.
 */
export async function discoverReportableMarkets(): Promise<ReportableMarket[]> {
  const config = loadConfig();
  if (!config.marketsApiUrl) {
    throw new Error("MARKETS_API_URL is not set - see .env.example");
  }

  const res = await fetch(config.marketsApiUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Markets feed returned ${res.status}`);
  }

  const markets = (await res.json()) as ReportableMarket[];
  if (!Array.isArray(markets)) {
    throw new Error(`Markets feed returned an unexpected shape: ${JSON.stringify(markets)}`);
  }

  const now = Date.now();
  return markets.filter((m) => {
    if (!m.questionId || !m.productCode || !m.resolutionTime) return false;
    const resolutionMs = new Date(m.resolutionTime).getTime();
    return !Number.isNaN(resolutionMs) && resolutionMs <= now;
  });
}
