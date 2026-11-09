import assert from 'node:assert/strict';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

// Reuse the real T04 HTTPS/PG/API/Nuxt fixture and its strict cleanup/data guards.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.env.WIDGET_CHAT_ACCEPTANCE = 'true';
  // Do not await here: the fixture imports this module to call the checks.
  void import('./widget.mjs');
}

export async function verifyVisitorChat({
  browser,
  request,
  db,
  siteA,
  siteB,
  widget,
  publicKey,
  configure,
  org,
  cookie,
  pass,
  evidence,
  api,
}) {
  await configure({ enabled: true, allowedOrigins: [siteA, siteB, widget] });
  const contexts = [];
  const errors = [];
  const newContext = async () => {
    const c = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(c);
    c.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
    return c;
  };
  const frame = (p) => p.frameLocator('iframe[title="SmartDesk 访客咨询"]');
  const messages = (f) => f.locator('article.message');
  const messageCount = async (content) =>
    (
      await db.query('SELECT count(*)::int n FROM messages WHERE content=$1', [
        content,
      ])
    ).rows[0].n;
  const send = async (f, content) => {
    await f.getByRole('textbox', { name: '消息', exact: true }).fill(content);
    await f.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(
      messages(f)
        .filter({ has: f.locator('p', { hasText: content }) })
        .last(),
    ).toHaveAttribute('data-status', 'sent', { timeout: 20000 });
  };
  try {
    const context = await newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookieControls', {
      enableThirdPartyCookieRestriction: true,
    });
    await context.addCookies([
      {
        name: 'member_canary',
        value: 'never-send',
        url: widget,
        secure: true,
        sameSite: 'None',
      },
    ]);
    const visitorRequests = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/conversations'))
        visitorRequests.push(r.allHeaders());
    });
    await page.goto(`${siteA}/demo/${publicKey}`);
    await expect(
      page.getByText('合成演示数据', { exact: false }).first(),
    ).toBeVisible();
    let f = frame(page);
    await expect(f.getByText('访客身份已连接', { exact: true })).toBeVisible();
    await expect(
      f.getByText('当前提供人工接待', { exact: false }),
    ).toBeVisible();
    await expect(f.getByLabel('邮箱（选填）')).toHaveValue('');
    const firstText = 'T10 无邮箱离线留言';
    await send(f, firstText);
    const row = (
      await db.query(
        'SELECT c.*, u.email FROM conversations c JOIN customers u ON u.id=c.customer_id JOIN messages m ON m.conversation_id=c.id WHERE m.content=$1',
        [firstText],
      )
    ).rows[0];
    assert.equal(row.email, null);
    assert.equal(row.status, 'waiting_human');
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int n FROM presence_connections WHERE organization_id=$1',
          [org],
        )
      ).rows[0].n,
      0,
    );
    await expect(f.getByText('尚未接通客服', { exact: false })).toBeVisible();
    pass('T10 真实 SaaS 演示页加载跨站脚本，无邮箱、无在线客服可持久化留言');

    await f.getByLabel('姓名（选填）').fill('合成访客');
    await f.getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(f.getByText('资料已保存', { exact: true })).toBeVisible();
    const token = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)).token,
      `smartdesk:visitor:${publicKey}:${siteA}`,
    );
    await page.reload();
    f = frame(page);
    await expect(messages(f).filter({ hasText: firstText })).toHaveAttribute(
      'data-status',
      'sent',
      { timeout: 15000 },
    );
    await expect(f.getByLabel('姓名（选填）')).toHaveValue('合成访客');
    assert.equal(
      await page.evaluate(
        (k) => JSON.parse(localStorage.getItem(k)).token,
        `smartdesk:visitor:${publicKey}:${siteA}`,
      ),
      token,
    );
    const other = await context.newPage();
    await other.goto(`${siteB}/demo/${publicKey}`);
    await expect(
      frame(other).getByText('访客身份已连接', { exact: true }),
    ).toBeVisible();
    await expect(messages(frame(other))).toHaveCount(0);
    await other.close();
    pass('T10 第三方 Cookie 禁用时跨站刷新恢复同凭据历史，另一父站点身份隔离');

    await page.route('**/handoff', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'SERVICE_UNAVAILABLE', message: '验收故障：暂不可用' },
        }),
      }),
    );
    await f.getByRole('button', { name: '转人工', exact: true }).click();
    await expect(
      f.getByRole('alert').filter({ hasText: '转人工尚未确认' }),
    ).toBeVisible();
    await expect(f.getByText('转人工请求已确认', { exact: true })).toHaveCount(
      0,
    );
    await page.unroute('**/handoff');
    let lostCommand;
    await page.route('**/handoff', async (route) => {
      lostCommand = route.request().headers()['idempotency-key'];
      const response = await route.fetch({
        url: api + new URL(route.request().url()).pathname,
      });
      assert.equal(response.status(), 200);
      await route.abort();
    });
    await f.getByRole('button', { name: '重试转人工请求' }).click();
    await expect(
      f.getByRole('alert').filter({ hasText: '转人工尚未确认' }),
    ).toBeVisible();
    await page.unroute('**/handoff');
    let retriedCommand;
    page.on('request', (r) => {
      if (r.url().endsWith('/handoff'))
        retriedCommand = r.headers()['idempotency-key'];
    });
    await f.getByRole('button', { name: '重试转人工请求' }).click();
    await expect(
      f.getByText('转人工请求已确认', { exact: true }),
    ).toBeVisible();
    assert.equal(retriedCommand, lostCommand);
    pass('T10 转人工失败不假报成功，提交后丢失响应使用相同命令恢复');

    const agentContext = await newContext();
    const split = cookie.indexOf('=');
    await agentContext.addCookies([
      {
        name: cookie.slice(0, split),
        value: cookie.slice(split + 1),
        url: widget,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const agentPage = await agentContext.newPage();
    await agentPage.goto(`${widget}/app/o/${org}/inbox/${row.id}`);
    await agentPage.getByRole('button', { name: '已离开 · 开始接待' }).click();
    await expect(
      agentPage.getByRole('button', { name: '接待中 · 切为离开' }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (
          await request('GET', '/presence', undefined, {
            member: true,
            status: 200,
          })
        ).data.some((m) => m.displayName === 'Widget Owner' && m.online),
      )
      .toBe(true);
    await expect(
      agentPage.getByRole('button', { name: '发送回复', exact: true }),
    ).toBeDisabled();
    await agentPage
      .getByRole('button', { name: '接管会话', exact: true })
      .click();
    await expect(f.getByText('人工接待', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(f.getByText('Widget Owner', { exact: false })).toBeVisible();
    await f
      .getByRole('textbox', { name: '消息', exact: true })
      .fill('正在编辑的访客草稿');
    await agentPage
      .getByLabel('公开回复', { exact: true })
      .fill('T10 人工真实回复');
    await agentPage
      .getByRole('button', { name: '发送回复', exact: true })
      .click();
    await expect(
      messages(f).filter({ hasText: 'T10 人工真实回复' }),
    ).toHaveAttribute('data-status', 'sent', { timeout: 15000 });
    await expect(
      f.getByRole('textbox', { name: '消息', exact: true }),
    ).toHaveValue('正在编辑的访客草稿');
    await request(
      'POST',
      `/conversations/${row.id}/notes`,
      { content: 'T10 内部备注不能泄漏', clientNoteId: randomUUID() },
      { member: true, status: 201 },
    );
    await expect(f.getByText('T10 内部备注不能泄漏')).toHaveCount(0);
    pass('T10 真实负责人认领与回复、显示名、事件不覆盖草稿、内部备注隔离');

    await f.getByRole('textbox', { name: '消息', exact: true }).fill('');
    await page.route('**/close', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'VERSION_CONFLICT',
            message: '记录已更新，请刷新后重试',
          },
        }),
      }),
    );
    await f.getByRole('button', { name: '结束咨询', exact: true }).click();
    await expect(
      f.getByRole('alert').filter({ hasText: '结束咨询尚未确认' }),
    ).toBeVisible();
    await expect(
      f.getByRole('textbox', { name: '消息', exact: true }),
    ).toBeVisible();
    await page.unroute('**/close');
    await f.getByRole('button', { name: '结束咨询', exact: true }).click();
    await expect(f.getByRole('button', { name: '发起新咨询' })).toBeVisible();
    await expect(
      f.getByRole('textbox', { name: '消息', exact: true }),
    ).toHaveCount(0);
    await f.getByRole('button', { name: '发起新咨询' }).click();
    let lostBody;
    await page.route('**/api/v1/conversations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      lostBody = route.request().postDataJSON();
      const response = await route.fetch({
        url: api + '/api/v1/conversations',
      });
      assert.equal(response.status(), 201);
      await route.abort();
    });
    await f
      .getByRole('textbox', { name: '消息', exact: true })
      .fill('T10 首消息提交后响应丢失');
    await f.getByRole('button', { name: '发送消息' }).click();
    await expect(f.getByRole('button', { name: '重试首条消息' })).toBeVisible();
    await expect(
      messages(f).filter({ hasText: 'T10 首消息提交后响应丢失' }),
    ).toHaveAttribute('data-status', 'pending');
    assert.equal(await messageCount('T10 首消息提交后响应丢失'), 1);
    await page.unroute('**/api/v1/conversations');
    let retryBody;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/v1/conversations') && r.method() === 'POST')
        retryBody = r.postDataJSON();
    });
    await f.getByRole('button', { name: '重试首条消息' }).click();
    await expect(
      messages(f).filter({ hasText: 'T10 首消息提交后响应丢失' }),
    ).toHaveAttribute('data-status', 'sent', { timeout: 15000 });
    assert.deepEqual(retryBody, lostBody);
    assert.equal(await messageCount('T10 首消息提交后响应丢失'), 1);
    await f.getByLabel('我的咨询').selectOption(row.id);
    await expect(messages(f).filter({ hasText: firstText })).toBeVisible();
    await expect(f.getByRole('button', { name: '发起新咨询' })).toBeVisible();
    pass(
      'T10 关闭只读、新咨询独立；首消息响应丢失未假报保存，同 ID 重试只有一条记录，旧历史可回看',
    );

    const second = (
      await db.query('SELECT conversation_id FROM messages WHERE content=$1', [
        'T10 首消息提交后响应丢失',
      ])
    ).rows[0].conversation_id;
    await f.getByLabel('我的咨询').selectOption(second);
    // Synthetic state fixture only: no fake AI output or model capability claim.
    await db.query(
      "UPDATE conversations SET status='ai_active', version=version+1 WHERE id=$1",
      [second],
    );
    await expect(f.getByText('AI 接待', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      f.getByText('AI 接待状态；当前未开放自动回复', { exact: false }),
    ).toBeVisible();
    await f.getByRole('button', { name: '转人工', exact: true }).click();
    await expect(f.getByText('等待人工', { exact: true })).toBeVisible();
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND sender_type='ai'",
          [second],
        )
      ).rows[0].n,
      0,
    );
    pass(
      'T10 四态由服务端驱动，合成 AI 状态无假回复；关闭 409 保留可用输入并允许重试',
    );
    await context.setOffline(true);
    await f
      .getByRole('textbox', { name: '消息', exact: true })
      .fill('T10 断线消息');
    await f.getByRole('button', { name: '发送消息' }).click();
    await expect(
      messages(f).filter({ hasText: 'T10 断线消息' }),
    ).toHaveAttribute('data-status', 'pending');
    assert.equal(await messageCount('T10 断线消息'), 0);
    await context.setOffline(false);
    await f.getByRole('button', { name: '重试此消息' }).click();
    await expect(
      messages(f).filter({ hasText: 'T10 断线消息' }),
    ).toHaveAttribute('data-status', 'sent', { timeout: 25000 });
    await send(f, 'T10 断线消息');
    assert.equal(await messageCount('T10 断线消息'), 2);
    pass('T10 断线待确认、恢复同 ID 重试、重复正文允许产生两条真实消息');

    const textarea = f.getByRole('textbox', { name: '消息', exact: true });
    await textarea.fill('T10 输入法测试');
    await textarea.dispatchEvent('compositionstart');
    await textarea.press('Enter');
    assert.equal(await messageCount('T10 输入法测试'), 0);
    await textarea.dispatchEvent('compositionend');
    await textarea.press('Shift+Enter');
    assert.match(await textarea.inputValue(), /\n/);
    await textarea.fill('T10 输入法测试');
    await textarea.press('Enter');
    await expect(
      messages(f).filter({ hasText: 'T10 输入法测试' }),
    ).toHaveAttribute('data-status', 'sent', { timeout: 15000 });
    await page.setViewportSize({ width: 320, height: 640 });
    await textarea.fill('窄屏保留的输入');
    await page.route('**/api/v1/conversations?*', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'SERVICE_UNAVAILABLE', message: '历史故障注入' },
        }),
      }),
    );
    await f.getByRole('button', { name: '刷新历史' }).click();
    await expect(f.getByRole('button', { name: '重试历史' })).toBeVisible();
    await page.unroute('**/api/v1/conversations?*');
    await f.getByRole('button', { name: '重试历史' }).click();
    await expect(f.getByRole('button', { name: '重试历史' })).toHaveCount(0);
    await expect(textarea).toHaveValue('窄屏保留的输入');
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    const actual = page
      .frames()
      .find((fr) => fr.url().startsWith(widget + '/widget/'));
    assert.equal(
      await actual.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: resolve(evidence, 't10-narrow.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.screenshot({
      path: resolve(evidence, 't10-desktop.png'),
      fullPage: true,
    });
    pass(
      'T10 组合输入不误发、Shift+Enter 换行、Enter 发送、320px 窄屏不溢出且保留输入',
    );

    const local = await newContext();
    const same = await local.newPage();
    await same.goto(`${widget}/demo/${publicKey}`);
    await expect(
      frame(same).getByText('访客身份已连接', { exact: true }),
    ).toBeVisible();
    await send(frame(same), 'T10 同站点演示留言');
    await request('GET', `/public/widgets/${publicKey}`, undefined, {
      origin: '',
      headers: { 'Sec-Fetch-Site': 'cross-site', Referer: siteA },
      status: 403,
    });
    await request('GET', `/public/widgets/${publicKey}`, undefined, {
      origin: '',
      headers: { 'Sec-Fetch-Site': 'same-origin', Referer: siteA },
      status: 403,
    });
    pass('T10 同站点演示真实加载成功，缺 Origin 的跨站/错 Referer 负例被拒绝');

    const volatile = await newContext();
    await volatile.addInitScript(() => {
      if (location.hostname === 'site-a.test') {
        Storage.prototype.getItem = () => {
          throw new Error('storage unavailable');
        };
        Storage.prototype.setItem = () => {
          throw new Error('storage unavailable');
        };
      }
    });
    const temporary = await volatile.newPage();
    await temporary.goto(`${siteA}/demo/${publicKey}`);
    await expect(
      frame(temporary).getByText('浏览器无法保存访客凭据', { exact: false }),
    ).toBeVisible();
    await send(frame(temporary), 'T10 无存储也能留言');
    for (const headers of await Promise.all(visitorRequests)) {
      assert.ok(headers.authorization?.startsWith('Bearer '));
      assert.equal(headers.cookie, undefined);
    }
    assert.deepEqual(errors, []);
    pass(
      'T10 首方存储不可用仍可本页留言，所有访客请求 Bearer 且不附成员 Cookie，无浏览器异常',
    );
  } catch (failure) {
    const snapshots = [];
    for (const c of contexts)
      for (const p of c.pages()) {
        snapshots.push({
          url: p.url(),
          frames: await Promise.all(
            p.frames().map(async (f) => ({
              url: f.url(),
              text: await f
                .locator('body')
                .innerText()
                .catch(() => ''),
            })),
          ),
        });
      }
    await writeFile(
      resolve(evidence, 'failure-pages.json'),
      JSON.stringify(snapshots, null, 2),
    );
    throw failure;
  } finally {
    for (const c of contexts) await c.close();
  }
}
