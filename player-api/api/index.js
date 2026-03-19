const app = require('../src/app');
const { connectDb } = require('../src/config/db');
const { parseBooleanEnv, validatePlayerApiEnv } = require('../src/config/env');
const { ensureSeedData } = require('../src/services/seedService');

let readyPromise;

function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      validatePlayerApiEnv();
      await connectDb();

      if (parseBooleanEnv('AUTO_SEED', true)) {
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
