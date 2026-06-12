require("dotenv").config();

module.exports = {
  SUI_RPC: process.env.SUI_RPC || "https://fullnode.testnet.sui.io:443",
  PREDICT_PKG:
    process.env.PREDICT_PKG ||
    "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
  PREDICT_OBJECT:
    process.env.PREDICT_OBJECT ||
    "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
  PREDICT_API:
    process.env.PREDICT_API ||
    "https://predict-server.testnet.mystenlabs.com",
  DUSDC_TYPE:
    process.env.DUSDC_TYPE ||
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
  PREDICTYIELD_PKG: process.env.PREDICTYIELD_PKG || "",
  PREDICTYIELD_VAULT: process.env.PREDICTYIELD_VAULT || "",
  KEEPER_PRIVATE_KEY: process.env.KEEPER_PRIVATE_KEY || "",
  PORT: parseInt(process.env.PORT || "3001", 10),
};
