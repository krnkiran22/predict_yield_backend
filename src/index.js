require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { PORT } = require("./lib/constants");
const { startKeeper } = require("./keeper/keeper");

const oraclesRouter = require("./routes/oracles");
const vaultRouter = require("./routes/vault");
const portfolioRouter = require("./routes/portfolio");

const app = express();

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",");
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "predictyield-backend",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Routes
app.use("/api/oracles", oraclesRouter);
app.use("/api/vault", vaultRouter);
app.use("/api/portfolio", portfolioRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("[server error]", err.message);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`[server] PredictYield backend running on port ${PORT}`);
  startKeeper();
});

module.exports = app;
