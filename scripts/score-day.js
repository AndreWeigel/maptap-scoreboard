#!/usr/bin/env node
// (Re)score a single date. Usage: node scripts/score-day.js 2026-07-20
const config = require('../config');
process.env.TZ = config.TZ;
const { openDb } = require('../src/db');
const { scoreDay } = require('../src/cron');

const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
  console.error('Usage: node scripts/score-day.js YYYY-MM-DD');
  process.exit(1);
}
scoreDay(openDb(config.DB_PATH), date);
