#!/usr/bin/env node

/**
 * Script to restore is_visitor column references after migrations are run
 * This script should be run after the database migrations have been executed successfully
 */

const fs = require('fs');
const path = require('path');

console.log('🔧 Restoring is_visitor column references...');

// Files to update
const filesToUpdate = [
  {
    path: 'server/routes/individuals.js',
    changes: [
      {
        from: '        -- i.is_visitor, -- Temporarily commented out until migration is run',
        to: '        i.is_visitor,'
      },
      {
        from: '      isVisitor: false, // Temporarily set to false until migration is run',
        to: '      isVisitor: Boolean(individual.is_visitor),'
      }
    ]
  },
  {
    path: 'server/routes/attendance.js',
    changes: [
      {
        from: '            INSERT INTO individuals (first_name, last_name, created_by)',
        to: '            INSERT INTO individuals (first_name, last_name, is_visitor, created_by)'
      },
      {
        from: '            VALUES (?, ?, ?)',
        to: '            VALUES (?, ?, true, ?)'
      }
    ]
  }
];

// Update each file
filesToUpdate.forEach(fileInfo => {
  const filePath = path.join(__dirname, '..', '..', fileInfo.path);
  
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return;
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  let updated = false;
  
  fileInfo.changes.forEach(change => {
    if (content.includes(change.from)) {
      content = content.replace(change.from, change.to);
      updated = true;
      console.log(`✅ Updated ${fileInfo.path}`);
    } else {
      console.log(`⚠️  Pattern not found in ${fileInfo.path}: ${change.from.substring(0, 50)}...`);
    }
  });
  
  if (updated) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`💾 Saved changes to ${fileInfo.path}`);
  }
});

console.log('🎉 is_visitor column references restored!');
console.log('');
console.log('Next steps:');
console.log('1. Commit the changes: git add . && git commit -m "Restore is_visitor column references"');
console.log('2. Build new Docker image: ./build-and-push.sh v0.2.7');
console.log('3. Deploy the new version'); 