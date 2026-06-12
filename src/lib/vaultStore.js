/**
 * In-memory vault state store with JSON file persistence.
 * Tracks V0 (vault_value_per_plp at deposit time) for each deposit batch.
 * This is the source of truth for PT/YT redemption calculations.
 */

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "../../vault_state.json");

let state = {
  deposits: {},     // address -> { plpHeld, ptMinted, ytMinted, v0, depositTime, oracleId }
  totalPlpHeld: 0,
  totalPtMinted: 0,
  totalYtMinted: 0,
  v0: null,         // vault_value_per_plp at first deposit (simplified: one batch per oracle)
  settled: false,
  settledAt: null,
  premiumEarned: 0,
};

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf8");
      state = JSON.parse(raw);
    }
  } catch {
    // start fresh if file is corrupt
  }
}

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save vault state:", e.message);
  }
}

function getState() {
  return state;
}

/**
 * Record a new deposit and the minted PT/YT amounts.
 * v0 is the vault_value_per_plp snapshotted from Predict at deposit time.
 */
function recordDeposit({ address, plpReceived, ptMinted, ytMinted, v0, oracleId }) {
  if (!state.deposits[address]) {
    state.deposits[address] = { plpHeld: 0, ptMinted: 0, ytMinted: 0, v0, oracleId, depositTime: Date.now() };
  }
  state.deposits[address].plpHeld += plpReceived;
  state.deposits[address].ptMinted += ptMinted;
  state.deposits[address].ytMinted += ytMinted;

  state.totalPlpHeld += plpReceived;
  state.totalPtMinted += ptMinted;
  state.totalYtMinted += ytMinted;

  if (!state.v0) state.v0 = v0;
  save();
}

/**
 * Compute PT and YT fair values given current v1 (vault_value_per_plp now).
 * PT value per token = min(v0, v1) in dUSDC per PLP unit
 * YT value per token = max(v1 - v0, 0) in dUSDC per PLP unit
 */
function computePTYTValues(v1) {
  const v0 = state.v0 || v1;
  const ptValuePerToken = Math.min(v0, v1);
  const ytValuePerToken = Math.max(v1 - v0, 0);
  return {
    v0,
    v1,
    ptValuePerToken,
    ytValuePerToken,
    totalPtMinted: state.totalPtMinted,
    totalYtMinted: state.totalYtMinted,
    totalPlpHeld: state.totalPlpHeld,
    totalPrincipalBacking: state.totalPtMinted * ptValuePerToken,
    totalYieldBacking: state.totalYtMinted * ytValuePerToken,
  };
}

function markSettled(premiumEarned) {
  state.settled = true;
  state.settledAt = Date.now();
  state.premiumEarned = premiumEarned;
  save();
}

function reset() {
  state = {
    deposits: {},
    totalPlpHeld: 0,
    totalPtMinted: 0,
    totalYtMinted: 0,
    v0: null,
    settled: false,
    settledAt: null,
    premiumEarned: 0,
  };
  save();
}

load();

module.exports = { getState, recordDeposit, computePTYTValues, markSettled, reset };
