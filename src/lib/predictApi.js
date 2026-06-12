const axios = require("axios");
const { PREDICT_API, PREDICT_OBJECT } = require("./constants");

const client = axios.create({
  baseURL: PREDICT_API,
  timeout: 10000,
});

async function getOracles(limit = 20, status = "active") {
  const { data } = await client.get(
    `/predicts/${PREDICT_OBJECT}/oracles?limit=${limit}`
  );
  if (status) {
    return data.filter((o) => o.status === status);
  }
  return data;
}

async function getOracleState(oracleId) {
  const { data } = await client.get(
    `/predicts/${PREDICT_OBJECT}/oracles/${oracleId}/state`
  );
  return data;
}

async function getExpiredOracles() {
  const { data } = await client.get(
    `/predicts/${PREDICT_OBJECT}/oracles?limit=50`
  );
  const now = Date.now();
  return data.filter(
    (o) => o.status === "active" && o.expiry <= now && !o.settled_at
  );
}

async function getPortfolio(address) {
  const { data } = await client.get(
    `/predicts/${PREDICT_OBJECT}/portfolios/${address}`
  );
  return data;
}

/**
 * Compute implied probability from oracle SVI params at a given strike.
 * Returns a value between 0 and 1.
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

  // Black-Scholes N(d2) for implied probability
  const d2 = (-k - 0.5 * vol * vol * T) / (vol * Math.sqrt(T));
  return normalCDF(d2);
}

function normalCDF(x) {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

module.exports = {
  getOracles,
  getOracleState,
  getExpiredOracles,
  getPortfolio,
  computeImpliedProbability,
};
