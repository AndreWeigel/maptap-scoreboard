#!/usr/bin/env node
// Rebuild all derived tables (daily_results) from the immutable results table.
const config = require('../config');
process.env.TZ = config.TZ;
const { openDb } = require('../src/db');
const { scoreDay } = require('../src/cron');

const db = openDb(config.DB_PATH);
const dates = db.getDates();
for (const date of dates) scoreDay(db, date);
console.log(`Recomputed ${dates.length} day(s).`);
