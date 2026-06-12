/**
 * PredictYield Keeper Service
 *
 * Runs every 2 minutes and:
 * 1. Checks for expired Predict oracles
 * 2. Calls predict::settle on expired oracles
 * 3. After settlement, triggers PredictYield vault settlement
 *    to distribute dUSDC to PT and YT holders
 */

const cron = require("node-cron");
const { SuiClient } = require("@mysten/sui/client");
const { Transaction } = require("@mysten/sui/transactions");
const { Ed25519Keypair } = require("@mysten/sui/keypairs/ed25519");
const { getExpiredOracles } = require("../lib/predictApi");
const { markSettled, getState } = require("../lib/vaultStore");
const {
  SUI_RPC,
  PREDICT_PKG,
  PREDICT_OBJECT,
  PREDICTYIELD_PKG,
  PREDICTYIELD_VAULT,
  KEEPER_PRIVATE_KEY,
  DUSDC_TYPE,
} = require("../lib/constants");

const suiClient = new SuiClient({ url: SUI_RPC });

let keeperKeypair = null;

function initKeeper() {
  if (!KEEPER_PRIVATE_KEY) {
    console.warn("[keeper] KEEPER_PRIVATE_KEY not set — keeper will run in dry-run mode");
    return;
  }
  try {
    const secretKey = Buffer.from(KEEPER_PRIVATE_KEY, "base64");
    keeperKeypair = Ed25519Keypair.fromSecretKey(secretKey);
    console.log(`[keeper] Initialized with address: ${keeperKeypair.getPublicKey().toSuiAddress()}`);
  } catch (e) {
    console.error("[keeper] Failed to init keypair:", e.message);
  }
}

/**
 * Settle a single expired Predict oracle on-chain.
 */
async function settleOracle(oracle) {
  if (!keeperKeypair) {
    console.log(`[keeper][dry-run] Would settle oracle ${oracle.oracle_id}`);
    return { dryRun: true, oracleId: oracle.oracle_id };
  }

  try {
    const tx = new Transaction();

    tx.moveCall({
      target: `${PREDICT_PKG}::predict::settle`,
      typeArguments: [DUSDC_TYPE],
      arguments: [
        tx.object(PREDICT_OBJECT),
        tx.object(oracle.oracle_id),
        tx.object("0x6"), // SUI Clock
      ],
    });

    tx.setGasBudget(50_000_000);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keeperKeypair,
      transaction: tx,
      options: { showEffects: true },
    });

    console.log(`[keeper] Settled oracle ${oracle.oracle_id} → digest: ${result.digest}`);
    return { success: true, digest: result.digest, oracleId: oracle.oracle_id };
  } catch (e) {
    console.error(`[keeper] Failed to settle oracle ${oracle.oracle_id}:`, e.message);
    return { success: false, error: e.message, oracleId: oracle.oracle_id };
  }
}

/**
 * After Predict settlement, trigger our vault to distribute dUSDC to PT/YT holders.
 * This requires the PredictYield contract to be deployed.
 */
async function settleYieldVault() {
  if (!PREDICTYIELD_PKG || !PREDICTYIELD_VAULT) {
    console.log("[keeper] PredictYield contract not deployed yet — skipping vault settlement");
    return;
  }

  if (!keeperKeypair) {
    console.log("[keeper][dry-run] Would settle PredictYield vault");
    return;
  }

  try {
    const tx = new Transaction();

    tx.moveCall({
      target: `${PREDICTYIELD_PKG}::predictyield::settle`,
      typeArguments: [DUSDC_TYPE],
      arguments: [
        tx.object(PREDICT_OBJECT),
        tx.object(PREDICTYIELD_VAULT),
        tx.object("0x6"),
      ],
    });

    tx.setGasBudget(100_000_000);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keeperKeypair,
      transaction: tx,
      options: { showEffects: true },
    });

    console.log(`[keeper] Vault settled → digest: ${result.digest}`);
    markSettled(0); // premium earned will be computed from on-chain event
    return { success: true, digest: result.digest };
  } catch (e) {
    console.error("[keeper] Vault settlement failed:", e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Main keeper loop — runs every 2 minutes.
 */
async function runKeeperCycle() {
  console.log(`[keeper] Running cycle at ${new Date().toISOString()}`);

  try {
    const expired = await getExpiredOracles();
    console.log(`[keeper] Found ${expired.length} expired oracle(s)`);

    for (const oracle of expired) {
      await settleOracle(oracle);
      // Small delay between settlements
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (expired.length > 0) {
      await settleYieldVault();
    }
  } catch (e) {
    console.error("[keeper] Cycle error:", e.message);
  }
}

function startKeeper() {
  initKeeper();
  console.log("[keeper] Starting — will check for expired oracles every 2 minutes");
  cron.schedule("*/2 * * * *", runKeeperCycle);
  // Run once immediately on startup
  setTimeout(runKeeperCycle, 5000);
}

module.exports = { startKeeper, runKeeperCycle, settleOracle };
