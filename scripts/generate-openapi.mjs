import assert from 'node:assert/strict';
import fs from 'node:fs';

// Renders contracts/openapi.json from the API route table (requires `npm run build`).
const {createMemoryApp} = await import('../apps/api/dist/index.js');
const outputPath = new URL('../contracts/openapi.json', import.meta.url);
const document = JSON.stringify(createMemoryApp().openApiDocument(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(outputPath, 'utf8'), document,
    'contracts/openapi.json is stale; run npm run build && npm run generate:openapi');
  console.log('contracts/openapi.json matches the API route table');
} else {
  fs.writeFileSync(outputPath, document);
  console.log('Wrote contracts/openapi.json');
}
