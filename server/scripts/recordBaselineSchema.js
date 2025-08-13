#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const SchemaIntrospector = require('../utils/schemaIntrospector');
const Database = require('../config/database');

async function main() {
  try {
    await Database.initialize();

    const introspector = new SchemaIntrospector();
    const schema = await introspector.getFullSchema();

    const outDir = path.join(__dirname, '..', 'schema');
    const outPath = path.join(outDir, 'baseline.schema.json');

    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(outPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      database: process.env.DB_NAME || 'church_attendance',
      schema
    }, null, 2));

    console.log(`✅ Baseline schema written to ${outPath}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to record baseline schema:', err.message);
    process.exit(1);
  }
}

main();


