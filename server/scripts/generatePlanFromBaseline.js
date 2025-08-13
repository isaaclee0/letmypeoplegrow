#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const MigrationPlanner = require('../utils/migrationPlanner');
const Database = require('../config/database');

async function main() {
  try {
    const baselinePath = process.argv[2] || path.join(__dirname, '..', 'schema', 'baseline.schema.json');
    if (!fs.existsSync(baselinePath)) {
      console.error(`❌ Baseline file not found at ${baselinePath}`);
      process.exit(1);
    }

    await Database.initialize();

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const desiredSchema = baseline.schema;

    const planner = new MigrationPlanner();
    const plan = await planner.generateMigrationPlan(desiredSchema);

    const outPath = path.join(path.dirname(baselinePath), 'plan.from-baseline.json');
    fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));

    console.log(`✅ Plan generated and written to ${outPath}`);
    console.log(`📋 Migrations to run: ${plan.migrations.length}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to generate plan from baseline:', err.message);
    process.exit(1);
  }
}

main();


