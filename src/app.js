const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const env = require("./config/env");
const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");
const notFound = require("./middleware/notFound");

const app = express();

if (env.TRUST_PROXY) app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json({ limit: "8mb" })); // verify payloads carry photo + docs
app.use(express.urlencoded({ extended: true, limit: "8mb" })); // accept HTML-form posts too

// No request logger (morgan) — quiet by design for Railway cost/stability.

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
