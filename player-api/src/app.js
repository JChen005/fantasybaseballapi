const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/healthRoutes');
const licenseRoutes = require('./routes/licenseRoutes');
const playerRoutes = require('./routes/playerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

app.use('/v1', healthRoutes);
app.use('/v1', licenseRoutes);
app.use('/v1', adminRoutes);
app.use('/v1', playerRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
