/**
 * EIP-712 typed-data constants for AgriOracle.submitReport.
 *
 * These MUST byte-match the contract's PRICE_TYPEHASH and EIP712 domain
 * exactly - field names, field order, and types all feed the struct hash,
 * so any drift produces a signature that recovers to the wrong address and
 * every submitReport call reverts with "Invalid signature".
 *
 * Source of truth (contracts/src/core/AgriOracle.sol):
 *   bytes32 public constant PRICE_TYPEHASH = keccak256(
 *       "SignedPrice(bytes32 questionId,string productCode,uint256 priceMin,uint256 priceMax,uint256 sourceDate,uint256 expiryTime,uint256 nonce)"
 *   );
 *   constructor(...) EIP712("AgriOracle", "1") { ... }
 *
 * questionId is FIRST (binds a signed price to one specific market) and
 * nonce is LAST (lets a reporter invalidate outstanding signatures via
 * invalidateNonce() without on-chain state per signature).
 */
export const SIGNED_PRICE_TYPES = {
  SignedPrice: [
    { name: "questionId", type: "bytes32" },
    { name: "productCode", type: "string" },
    { name: "priceMin", type: "uint256" },
    { name: "priceMax", type: "uint256" },
    { name: "sourceDate", type: "uint256" },
    { name: "expiryTime", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

// name/version passed to the EIP712 constructor. chainId and
// verifyingContract are filled in per-network at signing time (see
// src/oracle.ts) since they depend on where the reporter is running.
export const AGRI_ORACLE_DOMAIN = {
  name: "AgriOracle",
  version: "1",
} as const;
