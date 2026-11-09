import { expect, test } from '@playwright/test';

test('Nuxt 服务返回真实登录入口、代理与存活状态', async ({ request, page }) => {
  const live = await request.get('/health/live');
  expect(live.ok()).toBe(true);
  expect(await live.json()).toMatchObject({ service: 'web', status: 'ok' });
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '登录', exact: true }),
  ).toBeEnabled();
  const identity = await request.get('/api/v1/auth/me');
  expect(identity.status()).toBe(401);
  expect(await identity.json()).toMatchObject({
    error: { code: 'UNAUTHENTICATED' },
  });
});
