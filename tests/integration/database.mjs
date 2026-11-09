import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
const rootRequire = createRequire(
  new URL('../../package.json', import.meta.url),
);
const { Client } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('./dist/generated/prisma/client.js');
rootRequire('dotenv').config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});
const baseUrl = new URL(process.env.DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.toString() });
const root = fileURLToPath(new URL('../../', import.meta.url));
const prismaCli = rootRequire.resolve('prisma/build/index.js');
const seed = await readFile(
  new URL('../../database/seed.sql', import.meta.url),
  'utf8',
);
const initial = await readFile(
  new URL(
    '../../database/migrations/202611060001_initial/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const integrity = await readFile(
  new URL(
    '../../database/migrations/202611060002_integrity/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const fixture = {
  uA: '00000000-0000-4000-8000-000000000001',
  uB: '00000000-0000-4000-8000-000000000002',
  oA: '00000000-0000-4000-8000-000000000010',
  mA: '00000000-0000-4000-8000-000000000011',
  cA: '00000000-0000-4000-8000-000000000012',
  wA: '00000000-0000-4000-8000-000000000013',
  vA: '00000000-0000-4000-8000-000000000014',
  convA: '00000000-0000-4000-8000-000000000015',
  msg: '00000000-0000-4000-8000-000000000016',
  note: '00000000-0000-4000-8000-000000000017',
  sA: '00000000-0000-4000-8000-000000000018',
  pA: '00000000-0000-4000-8000-000000000019',
  oB: '00000000-0000-4000-8000-000000000020',
  mB: '00000000-0000-4000-8000-000000000021',
  cB: '00000000-0000-4000-8000-000000000022',
  wB: '00000000-0000-4000-8000-000000000023',
  vB: '00000000-0000-4000-8000-000000000024',
  convB: '00000000-0000-4000-8000-000000000025',
  sB: '00000000-0000-4000-8000-000000000028',
  pB: '00000000-0000-4000-8000-000000000029',
  doc: '00000000-0000-4000-8000-000000000030',
  ver: '00000000-0000-4000-8000-000000000031',
  chunk: '00000000-0000-4000-8000-000000000032',
  task: '00000000-0000-4000-8000-000000000040',
  result: '00000000-0000-4000-8000-000000000041',
  ticket: '00000000-0000-4000-8000-000000000050',
  ticketEvent: '00000000-0000-4000-8000-000000000051',
  outbox: '00000000-0000-4000-8000-000000000060',
  receipt: '00000000-0000-4000-8000-000000000061',
  audit: '00000000-0000-4000-8000-000000000062',
  invite: '00000000-0000-4000-8000-000000000070',
  event: '00000000-0000-4000-8000-000000000071',
};
let passed = 0;
const ownedDatabases = [];
function cli(args, url) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  console.info(
    JSON.stringify({
      command: 'prisma ' + args.join(' '),
      exitCode: result.status,
    }),
  );
  return result.stdout;
}
async function reject(client, name, state, action) {
  await client.query('BEGIN');
  try {
    await assert.rejects(action, (error) => error.code === state, name);
    passed++;
    console.info('PASS reject: ' + name + ' SQLSTATE=' + state);
  } finally {
    await client.query('ROLLBACK');
  }
}
async function clone(client, table, id, overrides = {}) {
  // Table names are fixed test literals, never request input.
  return client.query(
    `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(t) || $2::jsonb)).* FROM ${table} t WHERE id=$1`,
    [id, JSON.stringify({ id: randomUUID(), ...overrides })],
  );
}
await admin.connect();
try {
  for (const scenario of ['fresh', 'upgrade']) {
    const dbName =
      'smartdesk_t02_' + process.pid + '_' + Date.now() + '_' + scenario;
    assert.match(dbName, /^smartdesk_t02_[a-z0-9_]+$/);
    await admin.query('CREATE DATABASE "' + dbName + '"');
    ownedDatabases.push(dbName);
    const url = new URL(baseUrl);
    url.pathname = '/' + dbName;
    const db = new Client({ connectionString: url.toString() });
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString() }),
    });
    await db.connect();
    let upgradeSnapshot;
    try {
      if (scenario === 'fresh') {
        await db.query(initial.replace(/COMMIT;\s*$/, ''));
        await assert.rejects(
          () => db.query('SELECT 1/0'),
          (error) => error.code === '22012',
        );
        await db.query('ROLLBACK');
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
            )
          ).rows[0].n,
          0,
        );
        passed++;
        console.info('PASS failed initial migration rolls back all tables');
      }
      if (scenario === 'upgrade') {
        // Reproduce the committed first migration, baseline its history, then upgrade with rows present.
        await db.query(initial);
        cli(
          ['migrate', 'resolve', '--applied', '202611060001_initial'],
          url.toString(),
        );
        await db.query(seed);
        upgradeSnapshot = (await db.query('SELECT * FROM messages ORDER BY id'))
          .rows;
        await db.query(integrity.replace(/COMMIT;\s*$/, ''));
        await assert.rejects(
          () => db.query('SELECT 1/0'),
          (error) => error.code === '22012',
        );
        await db.query('ROLLBACK');
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM pg_constraint WHERE conname='message_sender_identity'",
            )
          ).rows[0].n,
          0,
        );
        passed++;
        console.info(
          'PASS failed integrity migration preserves existing data/schema',
        );
      }
      cli(['migrate', 'deploy'], url.toString());
      if (upgradeSnapshot) {
        assert.deepEqual(
          (await db.query('SELECT * FROM messages ORDER BY id')).rows,
          upgradeSnapshot.map((message) => ({
            ...message,
            conversation_version: 0,
          })),
        );
        passed++;
      }
      cli(
        [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'database/schema/schema.prisma',
          '--exit-code',
        ],
        url.toString(),
      );
      await db.query(seed);
      const before = await prisma.message.findMany({ orderBy: { id: 'asc' } });
      const seeded = spawnSync(process.execPath, ['scripts/seed.mjs'], {
        cwd: root,
        env: { ...process.env, SMARTDESK_SEED_DATABASE_URL: url.toString() },
        encoding: 'utf8',
      });
      assert.equal(seeded.status, 0, seeded.stderr + seeded.stdout);
      passed++;
      console.info('PASS seed CLI: exitCode=0');
      cli(['migrate', 'deploy'], url.toString());
      assert.deepEqual(
        await prisma.message.findMany({ orderBy: { id: 'asc' } }),
        before,
      );
      assert.equal(await prisma.organization.count(), 2);
      assert.equal(
        await prisma.customer.count({
          where: { emailNormalized: 'same@example.invalid' },
        }),
        2,
      );
      assert.equal(await prisma.conversationNote.count(), 1);
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: fixture.convA },
        include: {
          Message_conversation: true,
          ConversationNote_conversation: true,
        },
      });
      assert.equal(conversation.lastSeq, 1);
      assert.equal(conversation.Message_conversation.length, 1);
      assert.equal(conversation.ConversationNote_conversation.length, 1);
      const tables = await db.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'",
      );
      assert.equal(tables.rows[0].n, 24);
      passed += 6;
      if (scenario === 'upgrade') {
        console.info(
          'PASS upgrade: existing message/content/timestamps/relations retained; seed and deploy idempotent',
        );
        continue;
      }
      const bad = (name, state, table, key, changes) =>
        reject(db, name, state, () => clone(db, table, fixture[key], changes));
      const otherCustomer = randomUUID();
      await clone(db, 'customers', fixture.cA, { id: otherCustomer });
      await bad(
        'same-tenant ticket customer mismatch',
        '23503',
        'tickets',
        'ticket',
        { customer_id: otherCustomer, created_command_id: randomUUID() },
      );
      await bad(
        'same-tenant conversation visitor/customer mismatch',
        '23503',
        'conversations',
        'convA',
        { customer_id: otherCustomer, client_conversation_id: randomUUID() },
      );
      const otherDocument = randomUUID();
      const otherVersion = randomUUID();
      await clone(db, 'knowledge_documents', fixture.doc, {
        id: otherDocument,
        current_version_id: null,
      });
      await clone(db, 'knowledge_versions', fixture.ver, {
        id: otherVersion,
        document_id: otherDocument,
      });
      await reject(
        db,
        'same-tenant current version wrong document',
        '23503',
        () =>
          db.query(
            'UPDATE knowledge_documents SET current_version_id=$1 WHERE id=$2',
            [otherVersion, fixture.doc],
          ),
      );
      const otherConversation = randomUUID();
      const otherTask = randomUUID();
      await clone(db, 'conversations', fixture.convA, {
        id: otherConversation,
        client_conversation_id: randomUUID(),
      });
      await clone(db, 'ai_tasks', fixture.task, {
        id: otherTask,
        conversation_id: otherConversation,
      });
      await reject(db, 'active AI task wrong conversation', '23503', () =>
        db.query('UPDATE conversations SET active_ai_task_id=$1 WHERE id=$2', [
          otherTask,
          fixture.convA,
        ]),
      );
      await bad('tenant membership FK', '23503', 'conversation_notes', 'note', {
        author_membership_id: fixture.mB,
        client_note_id: randomUUID(),
      });
      await bad('tenant customer FK', '23503', 'visitor_sessions', 'vA', {
        customer_id: fixture.cB,
        token_hash: randomUUID(),
      });
      await bad('tenant widget FK', '23503', 'visitor_sessions', 'vA', {
        widget_config_id: fixture.wB,
        token_hash: randomUUID(),
      });
      await bad(
        'ticket customer matches conversation',
        '23503',
        'tickets',
        'ticket',
        { customer_id: fixture.cB, created_command_id: randomUUID() },
      );
      await bad(
        'conversation visitor/customer binding',
        '23503',
        'conversations',
        'convA',
        {
          created_by_visitor_session_id: fixture.vB,
          client_conversation_id: randomUUID(),
        },
      );
      await bad('public seq uniqueness', '23505', 'messages', 'msg', {
        client_message_id: randomUUID(),
      });
      await bad('message idempotency', '23505', 'messages', 'msg', { seq: 2 });
      await bad('negative message commit version', '23514', 'messages', 'msg', {
        seq: 2,
        client_message_id: randomUUID(),
        conversation_version: -1,
      });
      await reject(db, 'immutable message commit version', '23514', () =>
        db.query(
          'UPDATE messages SET conversation_version=conversation_version+1 WHERE id=$1',
          [fixture.msg],
        ),
      );
      await bad('note idempotency', '23505', 'conversation_notes', 'note', {});
      await bad('ticket create idempotency', '23505', 'tickets', 'ticket', {});
      await bad(
        'operation receipt idempotency',
        '23505',
        'operation_receipts',
        'receipt',
        {},
      );
      await bad('outbox idempotency', '23505', 'outbox_events', 'outbox', {});
      await bad('automatic task per input', '23505', 'ai_tasks', 'task', {});
      await bad('result per task', '23505', 'ai_results', 'result', {});
      await bad(
        'human active requires assignee',
        '23514',
        'conversations',
        'convA',
        { status: 'human_active', client_conversation_id: randomUUID() },
      );
      await bad(
        'waiting cannot have assignee',
        '23514',
        'conversations',
        'convA',
        {
          assigned_membership_id: fixture.mA,
          client_conversation_id: randomUUID(),
        },
      );
      await bad(
        'closed requires resolution',
        '23514',
        'conversations',
        'convA',
        { status: 'closed', client_conversation_id: randomUUID() },
      );
      await bad('unknown status', '23514', 'tickets', 'ticket', {
        status: 'bogus',
        created_command_id: randomUUID(),
      });
      await bad('negative version', '23514', 'tickets', 'ticket', {
        version: -1,
        created_command_id: randomUUID(),
      });
      await bad('visitor sender mismatch', '23514', 'messages', 'msg', {
        sender_id: fixture.mA,
        seq: 2,
        client_message_id: randomUUID(),
      });
      await bad(
        'nullable sender cannot bypass CHECK',
        '23514',
        'messages',
        'msg',
        { sender_customer_id: null, seq: 2, client_message_id: randomUUID() },
      );
      await bad('service sender spoof', '23514', 'messages', 'msg', {
        sender_type: 'system',
        sender_customer_id: null,
        seq: 2,
        client_message_id: randomUUID(),
      });
      await bad('message length', '23514', 'messages', 'msg', {
        content: '好'.repeat(8001),
        seq: 2,
        client_message_id: randomUUID(),
      });
      await bad(
        'knowledge test cannot own conversation',
        '23514',
        'ai_tasks',
        'task',
        {
          scope: 'knowledge_test',
          requested_by_membership_id: fixture.mA,
          command_id: randomUUID(),
          question_text: 'test',
        },
      );
      await bad(
        'knowledge chunk version belongs to document',
        '23503',
        'knowledge_chunks',
        'chunk',
        { document_id: randomUUID(), ordinal: 1 },
      );
      await bad('embedding dimension', '23514', 'knowledge_chunks', 'chunk', {
        embedding: '[1,0,0]',
        ordinal: 1,
      });
      await bad('embedding profile', '23514', 'knowledge_chunks', 'chunk', {
        embedding_profile_version: 'other',
        ordinal: 1,
      });
      await bad('zero embedding', '23514', 'knowledge_chunks', 'chunk', {
        embedding: '[0,0,0,0,0,0,0,0]',
        ordinal: 1,
      });
      await bad(
        'presence wrong user session',
        '23514',
        'presence_connections',
        'pA',
        { auth_session_id: fixture.sB },
      );
      await reject(db, 'current knowledge version ownership', '23503', () =>
        db.query(
          'UPDATE knowledge_documents SET current_version_id=$1 WHERE id=$2',
          [randomUUID(), fixture.doc],
        ),
      );
      await reject(db, 'message content immutable', '23514', () =>
        db.query("UPDATE messages SET content='changed' WHERE id=$1", [
          fixture.msg,
        ]),
      );
      await reject(db, 'knowledge body immutable', '23514', () =>
        db.query("UPDATE knowledge_versions SET body='changed' WHERE id=$1", [
          fixture.ver,
        ]),
      );
      await reject(db, 'historical membership delete restricted', '23503', () =>
        db.query('DELETE FROM memberships WHERE id=$1', [fixture.mA]),
      );
      // Multiple manual tasks for one source are legal with distinct commands; same command is rejected.
      const manual = {
        scope: 'conversation_assist',
        operation: 'summarize',
        requested_by_membership_id: fixture.mA,
        command_id: randomUUID(),
        source_through_seq: 1,
      };
      await clone(db, 'ai_tasks', fixture.task, manual);
      await bad(
        'manual command idempotency',
        '23505',
        'ai_tasks',
        'task',
        manual,
      );
      await clone(db, 'ai_tasks', fixture.task, {
        ...manual,
        command_id: randomUUID(),
      });
      const countBefore = await prisma.conversation.count();
      await clone(db, 'ai_tasks', fixture.task, {
        scope: 'knowledge_test',
        conversation_id: null,
        requested_by_membership_id: fixture.mA,
        command_id: randomUUID(),
        question_text: '合成试问',
      });
      assert.equal(await prisma.conversation.count(), countBefore);
      passed += 2;
      // A bounded representative sample gives the planner a reason to use the message index.
      await db.query(
        `INSERT INTO messages(organization_id,conversation_id,sender_id,sender_type,sender_customer_id,client_message_id,seq,content,content_hash)
        SELECT $1,$2,$3,'visitor',$3,gen_random_uuid(),g,'synthetic','fixture' FROM generate_series(2,10001) g`,
        [fixture.oA, fixture.convA, fixture.cA],
      );
      await db.query('ANALYZE messages');
      const explain = await db.query(
        'EXPLAIN (FORMAT JSON) SELECT * FROM messages WHERE organization_id=$1 AND conversation_id=$2 AND seq>9990 ORDER BY seq LIMIT 10',
        [fixture.oA, fixture.convA],
      );
      assert.match(JSON.stringify(explain.rows), /Index (Only )?Scan/);
      console.info('PASS query plan: ' + JSON.stringify(explain.rows));
      const vector = await db.query(
        'SELECT embedding <=> $1::vector AS distance FROM knowledge_chunks WHERE organization_id=$2 AND embedding_profile_version=$3',
        ['[1,0,0,0,0,0,0,0]', fixture.oA, 'fake-v1'],
      );
      assert.equal(vector.rows[0].distance, 0);
      passed += 2;
      console.info(
        'PASS fresh database: constraints, Prisma relations, scoped vector query',
      );
    } finally {
      await prisma.$disconnect();
      await db.end();
    }
  }
  console.info(
    JSON.stringify({
      status: 'PASS',
      assertions: passed,
      scenarios: ['fresh', 'upgrade'],
      realModelVerified: false,
    }),
  );
} finally {
  for (const name of ownedDatabases) {
    // Only databases created by this invocation; existing developer databases are never dropped.
    assert.match(name, /^smartdesk_t02_[a-z0-9_]+$/);
    await admin.query('DROP DATABASE "' + name + '"');
    console.info('CLEANED ' + name);
  }
  await admin.end();
}
