import { getOracleClients, AgriOracleAbi } from "./oracle.js";
import { loadConfig } from "./config.js";
import { fetchScaledPrice, StalePriceError } from "./price-source.js";
import { discoverReportableMarkets, type ReportableMarket } from "./markets.js";
import { SIGNED_PRICE_TYPES, AGRI_ORACLE_DOMAIN } from "./abi/domain.js";

// Substrings of revert reasons that mean "nothing to do here", not "the
// reporter is broken" - logged at info level and skipped rather than
// treated as an error worth waking someone up over.
const EXPECTED_REVERTS = [
  "Already reported",
  "Already resolved",
  "Reporting window closed",
  "Reporting failed",
  "window expired",
  "Stake below active threshold",
  "Not a registered reporter",
];

function isExpectedRevert(message: string): boolean {
  return EXPECTED_REVERTS.some((needle) => message.includes(needle));
}

async function hasAlreadyReported(
  clients: Awaited<ReturnType<typeof getOracleClients>>,
  questionId: `0x${string}`,
): Promise<boolean> {
  const reporters = (await clients.publicClient.readContract({
    address: clients.config.oracleAddress,
    abi: AgriOracleAbi,
    functionName: "getQuestionReporters",
    args: [questionId],
  })) as readonly `0x${string}`[];
  const me = clients.account.address.toLowerCase();
  return reporters.some((r) => r.toLowerCase() === me);
}

/**
 * Reads registration + stake, and (only when AUTO_TOPUP=true) tops the stake
 * back up to MIN_STAKE via addStake() when it has fallen below
 * ACTIVE_THRESHOLD - e.g. after a slash. Never auto-registers: registering
 * commits 1.01 ETH and is left to the explicit `cli register` command.
 * Returns whether the reporter is currently eligible to submit reports.
 */
async function ensureActive(clients: Awaited<ReturnType<typeof getOracleClients>>): Promise<boolean> {
  const { publicClient, walletClient, account, config } = clients;
  const address = config.oracleAddress;

  const [registered, stake] = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "getReporterInfo",
    args: [account.address],
  })) as [boolean, bigint, bigint, bigint, bigint];

  if (!registered) {
    console.warn(`[reporter] ${account.address} is not registered - run \`npm run cli register\` first`);
    return false;
  }

  const activeThreshold = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "ACTIVE_THRESHOLD",
  })) as bigint;

  if (stake >= activeThreshold) return true;

  if (!config.autoTopup) {
    console.warn(
      `[reporter] stake ${stake} wei is below ACTIVE_THRESHOLD (${activeThreshold} wei) and AUTO_TOPUP=false - ` +
        "reports will be skipped until you run `npm run cli topup`",
    );
    return false;
  }

  const minStake = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "MIN_STAKE",
  })) as bigint;
  const topUpAmount = minStake > stake ? minStake - stake : 0n;
  if (topUpAmount === 0n) return true;

  console.log(`[reporter] AUTO_TOPUP: stake fell to ${stake} wei, adding ${topUpAmount} wei`);
  const hash = await walletClient.writeContract({
    address,
    abi: AgriOracleAbi,
    functionName: "addStake",
    value: topUpAmount,
    chain: walletClient.chain,
    account,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.warn(`[reporter] AUTO_TOPUP addStake tx reverted: ${hash}`);
    return false;
  }
  return true;
}

async function submitReportForMarket(
  clients: Awaited<ReturnType<typeof getOracleClients>>,
  market: ReportableMarket,
): Promise<void> {
  const { publicClient, walletClient, account, config } = clients;
  const address = config.oracleAddress;

  if (await hasAlreadyReported(clients, market.questionId)) return;

  let price;
  try {
    price = await fetchScaledPrice(market.productCode);
  } catch (err) {
    if (err instanceof StalePriceError) {
      console.warn(`[reporter] skipping ${market.productCode}: ${err.message}`);
    } else {
      console.warn(`[reporter] price fetch failed for ${market.productCode}: ${(err as Error).message}`);
    }
    return;
  }

  const nonce = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "reporterNonce",
    args: [account.address],
  })) as bigint;

  const reportBond = (await publicClient.readContract({
    address,
    abi: AgriOracleAbi,
    functionName: "REPORT_BOND",
  })) as bigint;

  const expiryTime = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  // Same key signs and sends - the contract requires signer == msg.sender.
  const signature = await account.signTypedData({
    domain: {
      ...AGRI_ORACLE_DOMAIN,
      chainId: config.chainId,
      verifyingContract: address,
    },
    types: SIGNED_PRICE_TYPES,
    primaryType: "SignedPrice",
    message: {
      questionId: market.questionId,
      productCode: market.productCode,
      priceMin: price.priceMin,
      priceMax: price.priceMax,
      sourceDate: price.sourceDate,
      expiryTime,
      nonce,
    },
  });

  try {
    const hash = await walletClient.writeContract({
      address,
      abi: AgriOracleAbi,
      functionName: "submitReport",
      args: [
        market.questionId,
        market.productCode,
        price.priceMin,
        price.priceMax,
        price.sourceDate,
        expiryTime,
        nonce,
        signature,
      ],
      value: reportBond,
      chain: walletClient.chain,
      account,
    } as never);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.warn(`[reporter] submitReport reverted for ${market.productCode} (${market.questionId}): ${hash}`);
      return;
    }
    console.log(`[reporter] submitted ${market.productCode} for ${market.questionId} (tx ${hash})`);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (isExpectedRevert(message)) {
      console.log(`[reporter] skipped ${market.productCode} (${market.questionId}): ${message.slice(0, 80)}`);
    } else {
      console.warn(`[reporter] submitReport failed for ${market.productCode} (${market.questionId}): ${message.slice(0, 200)}`);
    }
  }
}

let cycleRunning = false;

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const clients = await getOracleClients();

    if (!(await ensureActive(clients))) return;

    const markets = await discoverReportableMarkets();
    for (const market of markets) {
      await submitReportForMarket(clients, market);
    }
  } catch (err) {
    console.error("[reporter] cycle error:", (err as Error).message);
  } finally {
    cycleRunning = false;
  }
}

export function startReporterLoop(): void {
  const config = loadConfig();
  console.log(`[reporter] starting - polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`[reporter] network=${config.network} chainId=${config.chainId} oracle=${config.oracleAddress}`);

  void runCycle();
  setInterval(() => void runCycle(), config.pollIntervalMs);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startReporterLoop();
}
