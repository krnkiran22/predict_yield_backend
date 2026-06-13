const axios = require("axios");
const { SuiClient } = require("@mysten/sui/client");
const { PREDICT_API, PREDICT_OBJECT, SUI_RPC } = require("./constants");

const suiClient = new SuiClient({ url: SUI_RPC });

const http = axios.create({
  baseURL: PREDICT_API,
  timeout: 10000,
});

async function getOracles(limit = 20, status = "active") {
  const { data } = await http.get(
    `/predicts/${PREDICT_OBJECT}/oracles?limit=${limit}`
  );
  if (status) return data.filter((o) => o.status === status);
  return data;
}

/**
 * Read OracleSVI state directly from the Sui chain.
 * The REST /state endpoint is not available on testnet; we read on-chain.
 *
 * On-chain oracle fields (confirmed live):
 *   prices.fields.spot / forward  — raw integer, divide by 1e9 for USD
 *   svi.fields.a / b / sigma       — positive integers, divide by 1e9
 *   svi.fields.rho / m             — I64 objects { is_negative, magnitude }
 */
async function getOracleState(oracleId) {
  const obj = await suiClient.getObject({
    id: oracleId,
    options: { showContent: true },
  });

  const fields = obj?.data?.content?.fields;
  if (!fields) return null;

  const priceFields = fields.prices?.fields || {};
  const sviFields = fields.svi?.fields || {};

  // Decode I64 helper
  const i64 = (f) =>
    f ? (f.fields.is_negative ? -f.fields.magnitude : +f.fields.magnitude) : 0;

  const SCALE = 1e9;

  return {
    spot_price: Number(priceFields.spot || 0) / SCALE,
    forward_price: Number(priceFields.forward || 0) / SCALE,
    expiry: Number(fields.expiry || 0),
    underlying_asset: fields.underlying_asset,
    active: fields.active,
    settlement_price: fields.settlement_price
      ? Number(fields.settlement_price) / SCALE
      : null,
    svi_params: sviFields.a != null
      ? {
          a: Number(sviFields.a) / SCALE,
          b: Number(sviFields.b) / SCALE,
          rho: i64(sviFields.rho) / SCALE,
          m: i64(sviFields.m) / SCALE,
          sigma: Number(sviFields.sigma) / SCALE,
        }
      : null,
  };
}

async function getExpiredOracles() {
  const { data } = await http.get(
    `/predicts/${PREDICT_OBJECT}/oracles?limit=50`
  );
  const now = Date.now();
  return data.filter(
    (o) => o.status === "active" && o.expiry <= now && !o.settled_at
  );
}

async function getPortfolio(address) {
  const { data } = await http.get(
    `/predicts/${PREDICT_OBJECT}/portfolios/${address}`
  );
  return data;
}

/**
 * Compute implied probability using SVI + Black-Scholes N(d2).
 */
function computeImpliedProbability(sviParams, strike, forwardPrice, expiryMs) {
  if (!sviParams) return 0.5;
  const { a, b, rho, m, sigma } = sviParams;
  const T = (expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000);
  if (T <= 0) return 0.5;
  const k = Math.log(strike / forwardPrice);
  const km = k - m;
  const w = a + b * (rho * km + Math.sqrt(km * km + sigma * sigma));
  const vol = Math.sqrt(Math.max(w, 0) / T);
  if (vol === 0) return 0.5;
  const d2 = (-k - 0.5 * vol * vol * T) / (vol * Math.sqrt(T));
  return normalCDF(d2);
}

function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const y =
    1.0 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

module.exports = {
  getOracles,
  getOracleState,
  getExpiredOracles,
  getPortfolio,
  computeImpliedProbability,
};
