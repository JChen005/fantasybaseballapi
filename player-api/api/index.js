const app = require("../src/app");
const { connectDb } = require("../src/config/db");
const { parseBooleanEnv, validatePlayerApiEnv } = require("../src/config/env");
const { ensureSeedData } = require("../src/services/seedService");

let readyPromise;

// validates env variables, starts mongoDB database connection
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      validatePlayerApiEnv();
      await connectDb();

      // feature flag to automatically refresh/populate player catalog during startup
      if (parseBooleanEnv("AUTO_SEED", true)) {
        await ensureSeedData({ force: false });
      }
    })();
  }

  return readyPromise;
}

module.exports = async (req, res) => {
  await ready();
  return app(req, res);
};
