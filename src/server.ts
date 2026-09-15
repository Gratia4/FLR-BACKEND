import { app } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";

const server = app.listen(config.PORT, "0.0.0.0", () => console.log(`FLR API listening on port ${config.PORT}`));

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
