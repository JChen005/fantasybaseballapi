require('dotenv').config();

const app = require('./app');
const { connectDb } = require('./config/db');
const { parseBooleanEnv, validatePlayerApiEnv } = require('./config/env');
const { ensureSeedData } = require('./services/seedService');

const port = Number(process.env.PORT || 5050);

async function bootstrap() {
  validatePlayerApiEnv();
  await connectDb();

  if (parseBooleanEnv('AUTO_SEED', true)) {
    await ensureSeedData({ force: false });
  }

  const server = app.listen(port, () => {
    console.log(`player-api listening on ${port}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use. Set a different PORT in player-api/.env or on your hosting platform and update the DraftKit API URL to match.`
      );
      process.exit(1);
    }

    console.error('Server error:', error);
    process.exit(1);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start player-api', error);
  process.exit(1);
});
