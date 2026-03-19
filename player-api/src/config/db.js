const mongoose = require('mongoose');

const globalCache = globalThis.__draftkitPlayerApiDb || {
  connection: null,
  promise: null,
};

globalThis.__draftkitPlayerApiDb = globalCache;

async function connectDb() {
  if (globalCache.connection) {
    return globalCache.connection;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }

  if (!globalCache.promise) {
    globalCache.promise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 10000,
      })
      .then((instance) => {
        console.log('Connected to MongoDB');
        return instance.connection;
      });
  }

  globalCache.connection = await globalCache.promise;
  return globalCache.connection;
}

module.exports = { connectDb };
