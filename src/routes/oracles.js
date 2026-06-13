const express = require("express");
const router = express.Router();
const { getOracles, getOracleState, computeImpliedProbability } = require("../lib/predictApi");

// GET /api/oracles — list active oracles
router.get("/", async (req, res) => {
  try {
    const oracles = await getOracles(20, "active");
    const now = Date.now();
    const enriched = oracles.map((o) => ({
      ...o,
      timeToExpiryMs: Math.max(o.expiry - now, 0),
      isExpired: o.expiry <= now,
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("oracles error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/oracles/:id — single oracle with SVI state
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [oracles, state] = await Promise.allSettled([
      getOracles(50, "active"),
      getOracleState(id),
    ]);

    const oracleList = oracles.status === "fulfilled" ? oracles.value : [];
    const oracle = oracleList.find((o) => o.oracle_id === id) || null;
    const oracleState = state.status === "fulfilled" ? state.value : null;

    const now = Date.now();
    const timeToExpiryMs = oracle ? Math.max(oracle.expiry - now, 0) : 0;

    // Compute implied probability at min_strike if SVI params available
    let impliedProbability = null;
    if (oracleState?.svi_params && oracle) {
      // min_strike is a raw integer scaled by 1e9 → divide to get USD
      const strike = oracle.min_strike / 1e9;
      impliedProbability = computeImpliedProbability(
        oracleState.svi_params,
        strike,
        oracleState.forward_price,
        oracle.expiry
      );
    }

    res.json({
      success: true,
      data: {
        oracle,
        state: oracleState,
        timeToExpiryMs,
        isExpired: oracle ? oracle.expiry <= now : false,
        impliedProbability,
      },
    });
  } catch (err) {
    console.error("oracle detail error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
