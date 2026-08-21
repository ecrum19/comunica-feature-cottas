const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const assetPath = resolve(__dirname, '../generated/dataset.cottas');
if (!existsSync(assetPath)) {
  throw new Error(
    'Missing generated/dataset.cottas. Complete the Phase 6 COTTAS asset-generation workflow before running WatDiv.',
  );
}
