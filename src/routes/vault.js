const express = require("express");
const router = express.Router();
const { SuiClient, getFullnodeUrl } = require("@mysten/sui/client");
const { getOracles } = require("../lib/predictApi");
const { computePTYTValues, getState, recordDeposit } = require("../lib/vaultStore");
const { SUI_RPC, PREDICT_OBJECT } = require("../lib/constants");

const suiClient = new SuiClient({ url: SUI_RPC });

/**
 * Read vault_value_per_plp from the Predict on-chain object.
 * Both vault.balance and treasury_cap.total_supply are raw integers
 * sharing the same 6-decimal dUSDC scale, so the ratio is unit-free.
 *
 * On-chain structure (confirmed live):
 *   Predict.vault.fields.balance           — raw vault dUSDC balance
 *   Predict.treasury_cap.fields.total_supply.fields.value — raw PLP supply
 */
async function fetchVaultValuePerPlp() {
  try {
    const obj = await suiClient.getObject({
      id: PREDICT_OBJECT,
      options: { showContent: true },
    });
    const fields = obj?.data?.content?.fields;
    if (!fields) return null;

    const vaultBalanceRaw = Number(fields.vault?.fields?.balance || 0);
    const plpSupplyRaw = Number(
      fields.treasury_cap?.fields?.total_supply?.fields?.value || 1
    );
    if (plpSupplyRaw === 0) return 1;

    // Both are in the same raw units — ratio gives dUSDC per PLP directly
    return vaultBalanceRaw / plpSupplyRaw;
  } catch {
    return null;
  }
}

// GET /api/vault — vault summary with PT/YT values
router.get("/", async (req, res) => {
  try {
    const v1 = await fetchVaultValuePerPlp();
    const vaultState = getState();
    const ptYtValues = v1 !== null ? computePTYTValues(v1) : null;

    // estimated APY based on oracle earnings (simplified)
    const activeOracles = await getOracles(5, "active").catch(() => []);

    res.json({
      success: true,
      data: {
        vaultValuePerPlp: v1,
        ptYtValues,
        vaultStore: {
          totalPlpHeld: vaultState.totalPlpHeld,
          totalPtMinted: vaultState.totalPtMinted,
          totalYtMinted: vaultState.totalYtMinted,
          v0: vaultState.v0,
          settled: vaultState.settled,
        },
        activeOracleCount: activeOracles.length,
      },
    });
  } catch (err) {
    console.error("vault error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/vault/pt-yt — PT and YT fair value calculation
router.get("/pt-yt", async (req, res) => {
  try {
    const v1 = await fetchVaultValuePerPlp();
    const vaultState = getState();

    if (!vaultState.v0) {
      return res.json({
        success: true,
        data: {
          v0: null,
          v1,
          ptValuePerToken: null,
          ytValuePerToken: null,
          message: "No deposits recorded yet. V0 not set.",
        },
      });
    }

    const values = computePTYTValues(v1 || vaultState.v0);
    res.json({ success: true, data: values });
  } catch (err) {
    console.error("pt-yt error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/vault/record-deposit — called after a successful on-chain deposit
// Body: { address, plpReceived, ptMinted, ytMinted, v0, oracleId }
router.post("/record-deposit", (req, res) => {
  try {
    const { address, plpReceived, ptMinted, ytMinted, v0, oracleId } = req.body;
    if (!address || !plpReceived || !ptMinted || !ytMinted || !v0) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    recordDeposit({ address, plpReceived, ptMinted, ytMinted, v0, oracleId });
    res.json({ success: true, message: "Deposit recorded", data: getState() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
