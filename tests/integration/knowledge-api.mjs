import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';

const base = process.env.API_BASE_URL;
assert.ok(
  base &&
    process.env.API_COOKIE &&
    process.env.API_ORG &&
    process.env.API_READY_ID,
  '需要已运行的隔离API及合成ready夹具',
);
const seen = new Set();
async function call(method, path, body, expected = 200, headers = {}) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      Origin: process.env.APP_ORIGIN,
      Cookie: process.env.API_COOKIE,
      'X-Organization-Id': process.env.API_ORG,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': randomUUID(),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  seen.add(method + ' ' + path.replace(/[0-9a-f-]{36}/g, ':id'));
  if (value) assert.ok(value.requestId);
  return value?.data;
}
async function run() {
  const input = {
    type: 'faq',
    titleOrQuestion: '归档接口验证',
    body: '合成测试正文',
  };
  let d = await call('POST', '/knowledge', input, 201);
  assert.ok(d.id);
  const old = d.currentVersion.id;
  assert.ok((await call('GET', '/knowledge')).items.some((x) => x.id === d.id));
  assert.equal(
    (await call('GET', `/knowledge/${d.id}`)).currentVersion.body,
    input.body,
  );
  d = await call('PATCH', `/knowledge/${d.id}`, {
    expectedVersion: d.version,
    titleOrQuestion: '第二版',
    body: '新正文',
  });
  assert.notEqual(d.currentVersion.id, old);
  assert.equal(
    (await call('GET', `/knowledge/${d.id}/versions`)).items.length,
    2,
  );
  assert.equal(
    (
      await call(
        'POST',
        `/knowledge/${d.id}/prepare`,
        { versionId: d.currentVersion.id },
        202,
      )
    ).preparationStatus,
    'not_started',
  );
  d = await call('GET', `/knowledge/${d.id}`);
  assert.equal(d.currentVersion.preparationRequested, true);
  await call(
    'POST',
    `/knowledge/${d.id}/enable`,
    { expectedVersion: d.version, versionId: d.currentVersion.id },
    409,
  );
  const ready = await call('GET', `/knowledge/${process.env.API_READY_ID}`);
  assert.equal(ready.currentVersion.preparationStatus, 'ready');
  assert.equal(
    (
      await call('POST', `/knowledge/${ready.id}/enable`, {
        expectedVersion: ready.version,
        versionId: ready.currentVersion.id,
      })
    ).status,
    'enabled',
  );
  d = await call('POST', `/knowledge/${d.id}/disable`, {
    expectedVersion: d.version,
  });
  assert.equal(d.status, 'disabled');
  await call('DELETE', `/knowledge/${d.id}`, {}, 204, {
    'If-Match': String(d.version),
  });
  await call('GET', `/knowledge/${d.id}`, undefined, 404);
  assert.equal(seen.size, 9);
  console.info(
    'API verification PASS: A043—A051 9/9；准备未冒充就绪，持久化读回通过',
  );
}
await run();
