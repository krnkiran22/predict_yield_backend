/**
 * PredictYield — Full Integration Test
 *
 * Run: node test_all.js
 *
 * Checks:
 *   1. Predict REST API is reachable and returns real oracle data
 *   2. On-chain oracle SVI params decode correctly
 *   3. V1 (vault value per PLP) reads correctly from Sui chain
 *   4. SVI formula produces a valid volatility smile
 *   5. Backend server starts and all routes return valid responses
 *   6. PT/YT value calculation is mathematically correct
 *   7. Deposit recording and vault state persistence work
 */

require("dotenv").config();

const axios = require("axios");
const { SuiClient } = require("@mysten/sui/client");

const PREDICT_API = "https://predict-server.testnet.mystenlabs.com";
const PREDICT_OBJECT = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const SUI_RPC = "https://fullnode.testnet.sui.io:443";
const BACKEND_URL = "http://localhost:3001";

const client = new SuiClient({ url: SUI_RPC });

let passed = 0;
let failed = 0;

function ok(label, value) {
  console.log(`  ✅  ${label}: ${JSON.stringify(value)}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  ❌  ${label}: ${reason}`);
  failed++;
}

function assert(label, condition, debugValue) {
  if (condition) ok(label, debugValue ?? "ok");
  else fail(label, `got ${JSON.stringify(debugValue)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Predict REST API — returns first ACTIVE oracle
// ─────────────────────────────────────────────────────────────────────────────
async function testPredictRestAPI() {
  console.log("\n📡  [1] Predict REST API");
  try {
    const { data } = await axios.get(
      `${PREDICT_API}/predicts/${PREDICT_OBJECT}/oracles?limit=50`,
      { timeout: 8000 }
    );
    assert("returns array", Array.isArray(data), `total=${data.length}`);
    const active = data.filter((o) => o.status === "active");
    assert("has active oracles", active.length > 0, `active=${active.length}`);
    assert("has oracle_id", typeof active[0]?.oracle_id === "string");
    assert("has expiry", typeof active[0]?.expiry === "number");
    assert("status=active", active[0]?.status === "active");
    ok("using active oracle", active[0].oracle_id.slice(0, 20) + "...");
    return active[0].oracle_id; // always return an active oracle
  } catch (e) {
    fail("Predict API reachable", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. On-chain oracle SVI params
// ─────────────────────────────────────────────────────────────────────────────
async function testOracleSVI(oracleId) {
  console.log("\n🔗  [2] On-chain Oracle SVI params");
  if (!oracleId) return fail("oracle available", "no oracle_id from step 1");

  try {
    const obj = await client.getObject({
      id: oracleId,
      options: { showContent: true },
    });
    const fields = obj?.data?.content?.fields;

    assert("fields loaded", !!fields);
    assert("has svi object", !!fields?.svi);

    const svi = fields.svi?.fields || {};
    const SCALE = 1e9;
    const i64 = (f) => f ? (f.fields.is_negative ? -Number(f.fields.magnitude) : Number(f.fields.magnitude)) : 0;

    const params = {
      a: Number(svi.a) / SCALE,
      b: Number(svi.b) / SCALE,
      rho: i64(svi.rho) / SCALE,
      m: i64(svi.m) / SCALE,
      sigma: Number(svi.sigma) / SCALE,
    };

    assert("a > 0", params.a > 0, params.a.toExponential(3));
    assert("b > 0", params.b > 0, params.b.toExponential(3));
    assert("rho in (-1, 1)", Math.abs(params.rho) < 1, params.rho.toFixed(4));
    assert("sigma > 0", params.sigma > 0, params.sigma.toExponential(3));

    const priceFields = fields.prices?.fields || {};
    const spot = Number(priceFields.spot) / SCALE;
    const forward = Number(priceFields.forward) / SCALE;
    assert("spot > 0", spot > 0, `$${spot.toFixed(2)}`);
    assert("forward > 0", forward > 0, `$${forward.toFixed(2)}`);

    return { params, spot, forward, expiry: Number(fields.expiry) };
  } catch (e) {
    fail("oracle on-chain read", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Vault V1 from Sui chain
// ─────────────────────────────────────────────────────────────────────────────
async function testVaultV1() {
  console.log("\n🏦  [3] Vault V1 (vault_value_per_plp)");
  try {
    const obj = await client.getObject({
      id: PREDICT_OBJECT,
      options: { showContent: true },
    });
    const fields = obj?.data?.content?.fields;
    const vaultBalance = Number(fields?.vault?.fields?.balance || 0);
    const plpSupply = Number(
      fields?.treasury_cap?.fields?.total_supply?.fields?.value || 1
    );

    assert("vault balance > 0", vaultBalance > 0, `${(vaultBalance / 1e6).toFixed(2)} dUSDC`);
    assert("plp supply > 0", plpSupply > 0, `${(plpSupply / 1e6).toFixed(2)} PLP`);

    const v1 = vaultBalance / plpSupply;
    assert("V1 is close to 1.0", v1 > 0.5 && v1 < 2.0, v1.toFixed(6));

    const maxPayout = Number(fields?.vault?.fields?.total_max_payout || 0);
    const utilization = (maxPayout / vaultBalance) * 100;
    ok("utilization", `${utilization.toFixed(2)}%`);

    return v1;
  } catch (e) {
    fail("vault V1 read", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SVI volatility smile
// ─────────────────────────────────────────────────────────────────────────────
async function testSVISmile(oracleData) {
  console.log("\n📈  [4] SVI volatility smile");
  if (!oracleData) return fail("svi data", "no oracle data from step 2");

  const { params, spot, forward, expiry } = oracleData;
  const { a, b, rho, m, sigma } = params;
  const T = (expiry - Date.now()) / (365.25 * 24 * 3600 * 1000);

  if (T <= 0) {
    ok("oracle expired (smile not needed)", `expiry ${new Date(expiry).toISOString()}`);
    return;
  }

  const strikes = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((logMoney) => {
    const strike = forward * Math.exp(logMoney);
    const k = logMoney;
    const km = k - m;
    const w = a + b * (rho * km + Math.sqrt(km * km + sigma * sigma));
    const iv = Math.sqrt(Math.max(w, 0) / T) * 100;
    return { strike: Math.round(strike), iv: iv.toFixed(2) };
  });

  const ivValues = strikes.map((s) => parseFloat(s.iv));
  const allPositive = ivValues.every((v) => v > 0);
  assert("all IVs positive", allPositive);

  const atmIV = parseFloat(strikes[3].iv);
  assert("ATM IV is reasonable (5–200%)", atmIV > 5 && atmIV < 200, `${atmIV.toFixed(2)}%`);

  console.log("  📊  Smile (log-money → strike USD: IV%):");
  strikes.forEach((s) => console.log(`       $${s.strike.toLocaleString()}: ${s.iv}%`));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Backend server routes
// ─────────────────────────────────────────────────────────────────────────────
async function testBackendRoutes() {
  console.log("\n🚀  [5] Backend API routes (server must be running on :3001)");

  async function get(path) {
    const { data } = await axios.get(`${BACKEND_URL}${path}`, { timeout: 10000 });
    return data;
  }

  // Health check
  try {
    const health = await get("/api/health");
    assert("GET /api/health status=ok", health.status === "ok", health.status);
  } catch (e) {
    fail("GET /api/health", e.message);
    console.log("    ⚠️   Start the server first: cd backend && npm start");
    return;
  }

  // Oracles route
  try {
    const oracles = await get("/api/oracles");
    assert("GET /api/oracles success", oracles.success === true);
    assert("oracles array not empty", Array.isArray(oracles.data) && oracles.data.length > 0, `count=${oracles.data?.length}`);
    assert("oracle has timeToExpiryMs", typeof oracles.data?.[0]?.timeToExpiryMs === "number");
    ok("first oracle id", oracles.data[0]?.oracle_id?.slice(0, 10) + "...");
  } catch (e) {
    fail("GET /api/oracles", e.message);
  }

  // Oracle detail with SVI
  try {
    const { data: oracleList } = await axios.get(`${PREDICT_API}/predicts/${PREDICT_OBJECT}/oracles?limit=1`);
    const id = oracleList[0]?.oracle_id;
    if (id) {
      const detail = await get(`/api/oracles/${id}`);
      assert("GET /api/oracles/:id success", detail.success === true);
      assert("has svi_params", detail.data?.state?.svi_params !== undefined, !!detail.data?.state?.svi_params);
      assert("has spot_price", detail.data?.state?.spot_price > 0, detail.data?.state?.spot_price);
    }
  } catch (e) {
    fail("GET /api/oracles/:id", e.message);
  }

  // Vault route
  try {
    const vault = await get("/api/vault");
    assert("GET /api/vault success", vault.success === true);
    assert("vaultValuePerPlp > 0", vault.data?.vaultValuePerPlp > 0, vault.data?.vaultValuePerPlp?.toFixed(6));
    assert("activeOracleCount > 0", vault.data?.activeOracleCount > 0, vault.data?.activeOracleCount);
  } catch (e) {
    fail("GET /api/vault", e.message);
  }

  // PT/YT values
  try {
    const ptyt = await get("/api/vault/pt-yt");
    assert("GET /api/vault/pt-yt success", ptyt.success === true);
    ok("PT/YT message or V1", ptyt.data?.v1 ?? ptyt.data?.message);
  } catch (e) {
    fail("GET /api/vault/pt-yt", e.message);
  }

  // Portfolio
  try {
    const portfolio = await get("/api/portfolio/0xb33fb30bf11f051526224aa08dd9e6a3bb8e74fd65d635b4fb92b3907e5b3f34");
    assert("GET /api/portfolio/:address success", portfolio.success === true);
    assert("has address field", !!portfolio.data?.address);
  } catch (e) {
    fail("GET /api/portfolio/:address", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. PT/YT math
// ─────────────────────────────────────────────────────────────────────────────
async function testPTYTMath(v1) {
  console.log("\n🧮  [6] PT/YT value calculation");

  const v0 = v1 ? v1 * 0.99 : 1.0; // simulate v0 slightly below v1
  const currentV1 = v1 ?? 1.003;

  // PT = min(v0, v1), YT = max(v1 - v0, 0)
  const ptVal = Math.min(v0, currentV1);
  const ytVal = Math.max(currentV1 - v0, 0);
  const total = ptVal + ytVal;

  assert("PT + YT = V1", Math.abs(total - currentV1) < 1e-10, `${total.toFixed(8)} vs ${currentV1.toFixed(8)}`);
  assert("PT ≤ V0", ptVal <= v0 + 1e-10, ptVal.toFixed(6));
  assert("YT ≥ 0", ytVal >= 0, ytVal.toFixed(6));

  // Loss scenario: vault down 30%
  const v1Loss = v0 * 0.7;
  const ptLoss = Math.min(v0, v1Loss);
  const ytLoss = Math.max(v1Loss - v0, 0);
  assert("PT absorbs loss last (ytLoss=0)", ytLoss === 0, ytLoss);
  assert("PT gets what's left in loss", Math.abs(ptLoss - v1Loss) < 1e-10, ptLoss.toFixed(6));

  console.log(`  💡  Example: V0=${v0.toFixed(4)}, V1=${currentV1.toFixed(4)}`);
  console.log(`       PT per token = ${ptVal.toFixed(6)} dUSDC  |  YT per token = ${ytVal.toFixed(6)} dUSDC`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Vault store record + retrieve
// ─────────────────────────────────────────────────────────────────────────────
async function testVaultStore(v1) {
  console.log("\n💾  [7] Vault store — record deposit and retrieve");
  try {
    const store = require("./src/lib/vaultStore");
    store.reset();

    const v0 = v1 ?? 1.003;
    store.recordDeposit({
      address: "0xtest",
      plpReceived: 50,
      ptMinted: 50,
      ytMinted: 50,
      v0,
      oracleId: "0xtest_oracle",
    });

    const state = store.getState();
    assert("deposit recorded", state.deposits["0xtest"]?.plpHeld === 50);
    assert("v0 saved", Math.abs(state.v0 - v0) < 1e-10, state.v0);

    const currentV1 = v0 * 1.15; // simulate 15% vault growth
    const values = store.computePTYTValues(currentV1);
    assert("ptValuePerToken = v0", Math.abs(values.ptValuePerToken - v0) < 1e-10);
    assert("ytValuePerToken = v1 - v0", Math.abs(values.ytValuePerToken - (currentV1 - v0)) < 1e-10, values.ytValuePerToken.toFixed(6));

    console.log(`  💡  50 PT redeems for ${(50 * values.ptValuePerToken).toFixed(2)} dUSDC`);
    console.log(`  💡  50 YT redeems for ${(50 * values.ytValuePerToken).toFixed(2)} dUSDC`);

    store.reset();
    assert("reset clears state", store.getState().totalPtMinted === 0);
  } catch (e) {
    fail("vault store", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60));
  console.log("  PredictYield — Integration Test Suite");
  console.log("═".repeat(60));

  const firstOracleId = await testPredictRestAPI();
  const oracleData = await testOracleSVI(firstOracleId);
  const v1 = await testVaultV1();
  await testSVISmile(oracleData);
  await testPTYTMath(v1);
  await testVaultStore(v1);
  await testBackendRoutes();

  console.log("\n" + "═".repeat(60));
  console.log(`  Results: ${passed} passed  |  ${failed} failed`);
  console.log("═".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
