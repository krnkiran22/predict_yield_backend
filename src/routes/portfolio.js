const express = require("express");
const router = express.Router();
const { getPortfolio } = require("../lib/predictApi");
const { getState, computePTYTValues } = require("../lib/vaultStore");

// GET /api/portfolio/:address — user's positions and PT/YT holdings
router.get("/:address", async (req, res) => {
  try {
    const { address } = req.params;

    // Fetch raw Predict positions for this address
    let predictPortfolio = null;
    try {
      predictPortfolio = await getPortfolio(address);
    } catch {
      predictPortfolio = null;
    }

    // Get this user's deposit record from our vault store
    const vaultState = getState();
    const userDeposit = vaultState.deposits[address] || null;

    // Compute current PT/YT values if we have V0
    let ptYtValues = null;
    if (vaultState.v0) {
      ptYtValues = computePTYTValues(vaultState.v0); // v1 = v0 if no live feed
    }

    res.json({
      success: true,
      data: {
        address,
        predictPositions: predictPortfolio,
        predictYieldPosition: userDeposit
          ? {
              plpHeld: userDeposit.plpHeld,
              ptMinted: userDeposit.ptMinted,
              ytMinted: userDeposit.ytMinted,
              v0: userDeposit.v0,
              depositTime: userDeposit.depositTime,
              oracleId: userDeposit.oracleId,
              estimatedPtValue: userDeposit.ptMinted * (ptYtValues?.ptValuePerToken || userDeposit.v0),
              estimatedYtValue: userDeposit.ytMinted * (ptYtValues?.ytValuePerToken || 0),
            }
          : null,
      },
    });
  } catch (err) {
    console.error("portfolio error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
