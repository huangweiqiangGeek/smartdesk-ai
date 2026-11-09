import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const require = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
);
const { Client } = require('pg');
const url = process.env.SMARTDESK_SEED_DATABASE_URL;
if (!url || !/^\/smartdesk_t02_[a-z0-9_]+$/.test(new URL(url).pathname)) {
  throw new Error(
    'Set SMARTDESK_SEED_DATABASE_URL to an isolated smartdesk_t02_* fixture database.',
  );
}
const client = new Client({ connectionString: url });
try {
  await client.connect();
  await client.query(
    await readFile(new URL('../database/seed.sql', import.meta.url), 'utf8'),
  );
  console.info('Synthetic seed applied (idempotent).');
} finally {
  await client.end();
}
