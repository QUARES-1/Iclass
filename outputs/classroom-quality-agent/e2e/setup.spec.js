import {test, expect} from '@playwright/test';

async function fixture(page, overrides = {}) {
  const original = await (await page.request.get('/api/model-settings')).json();
  const state = {
    posts: {model: [], feedback: []}, tests: [], ...overrides,
    model: {...original, apiKeyConfigured: true, ...overrides.model},
    feedback: {revision: 0, baseUrl: 'https://jinshuju.net/api/v1', configured: true, ...overrides.feedback},
  };
  for (const kind of ['model', 'feedback']) {
    const endpoint = kind === 'model' ? '/api/model-settings' : '/api/feedback/settings';
    await page.context().route(url => url.pathname === endpoint || url.pathname === endpoint + '/test', async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        if (state[kind + 'Error']) return route.fulfill({status: 503, json: {error: '暂时无法读取配置'}});
        return route.fulfill({json: state[kind]});
      }
      const body = request.postDataJSON();
      if (request.url().endsWith('/test')) {
        state.tests.push({kind, body});
        if (state.testGate) await state.testGate;
        return route.fulfill({status: state.testError ? 502 : 200, json: state.testError ? {error: '连接失败，请检查凭据和额度。'} : {ok: true}});
      }
      state.posts[kind].push(body);
      if (state.conflict) {
        state.conflict = false;
        state.model = {...state.model, revision: state.model.revision + 1, model: 'other-tab-model', apiKeyConfigured: true};
        return route.fulfill({status: 409, json: {error: '配置已在其他页面更新，请重新检测。'}});
      }
      const next = {...state[kind], ...body, revision: state[kind].revision + 1};
      if (kind === 'model') { next.apiKeyConfigured = Boolean(body.apiKey?.trim()) || state.model.apiKeyConfigured; delete next.apiKey; }
      else { next.configured = Boolean(body.accessToken?.trim()) || state.feedback.configured; delete next.accessToken; }
      state[kind] = next;
      return route.fulfill({json: next});
    });
  }
  return state;
}

test('首次启动逐项补齐模型和可选问卷，测试不保存，保存后不再弹出', async ({page}) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = await fixture(page, {model: {baseUrl: '', model: '', apiKeyConfigured: false}, feedback: {configured: false}});
  await page.goto('/public/home.html');
  await expect(page.locator('#setup-title')).toHaveText('连接 AI 模型');
  await expect(page.locator('#setup-progress')).toContainText('2 项');
  await expect(page.locator('#setup-missing')).toContainText('API 地址、模型名称、API Key');
  await expect(page.locator('#setup-url')).toBeFocused();
  await page.locator('#setup-url').fill('https://example.test/v1'); await page.locator('#setup-model').fill('teacher-model');
  await page.locator('#setup-key').fill('onboarding-model-fixture');
  await page.locator('#setup-test').click(); await expect(page.locator('#setup-status')).toContainText('连接成功');
  expect(state.posts.model).toHaveLength(0);
  await page.locator('#setup-save').click();
  await expect(page.locator('#setup-title')).toHaveText('连接金数据问卷（可选）');
  await expect(page.locator('#setup-model')).toBeHidden(); await expect(page.locator('#setup-key')).toHaveValue('');
  await expect(page.locator('#setup-key')).toBeFocused(); await expect(page.locator('#setup-key-help')).toContainText('个人中心');
  await page.locator('#setup-key').fill('onboarding-provider-fixture');
  await page.locator('#setup-test').click(); await expect(page.locator('#setup-status')).toContainText('连接成功');
  expect(state.posts.feedback).toHaveLength(0);
  await page.locator('#setup-save').click(); await expect(page.locator('.api-setup')).not.toBeVisible();
  await expect(page.locator('.setup-reminder')).toBeHidden();
  expect(state.posts.model).toHaveLength(1); expect(state.posts.feedback).toHaveLength(1);
  await page.reload(); await expect(page.locator('#home-model')).not.toContainText('正在读取');
  await expect(page.locator('.api-setup')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('onboarding-');
  expect(errors).toEqual([]);
});

test('已有密钥但缺少地址或模型时只补字段，留空密钥保留已有值', async ({page}) => {
  const state = await fixture(page, {model: {baseUrl: 'file:///invalid', model: '   '}});
  await page.goto('/public/index.html'); await expect(page.locator('.api-setup')).toBeVisible();
  await expect(page.locator('#setup-missing')).toHaveText('待补齐：API 地址、模型名称');
  await expect(page.locator('#setup-key')).not.toHaveAttribute('required', '');
  await expect(page.locator('#setup-key-help')).toContainText('留空即可保留');
  await page.locator('#setup-url').fill('https://example.test/v1'); await page.locator('#setup-model').fill('fixed-model');
  await page.locator('#setup-test').click(); await expect(page.locator('#setup-status')).toContainText('连接成功');
  await page.locator('#setup-save').click(); await expect(page.locator('.api-setup')).not.toBeVisible();
  expect(state.posts.model[0].apiKey).toBe(''); expect(state.model.apiKeyConfigured).toBe(true);
});

test('可选问卷引导可跳过，跨页不重复打扰，保留补齐入口', async ({page}) => {
  await fixture(page, {feedback: {configured: false}});
  await page.goto('/public/home.html'); await expect(page.locator('#setup-title')).toContainText('问卷（可选）');
  await expect(page.locator('#setup-intro')).toContainText('暂不连接也能');
  await page.locator('#setup-skip').click(); await expect(page.locator('.setup-reminder')).toContainText('金数据问卷（可选）');
  await page.reload(); await expect(page.locator('.setup-reminder')).toBeVisible(); await expect(page.locator('.api-setup')).toHaveCount(0);
  await page.goto('/public/index.html'); await expect(page.locator('#save-status')).not.toHaveText('正在恢复…');
  await expect(page.locator('.setup-reminder')).toBeHidden(); await expect(page.locator('.api-setup')).toHaveCount(0);
  await page.goto('/public/sprint3.html'); await expect(page.locator('.setup-reminder')).toBeVisible(); await expect(page.locator('.api-setup')).toHaveCount(0);
  await page.getByRole('button', {name: '补齐配置'}).click(); await expect(page.locator('.api-setup')).toBeVisible();
  await expect(page.locator('#setup-full-settings')).toHaveAttribute('href', './settings.html#feedback-settings-form');
});

test('部分配置接口失败不遮蔽另一项，重试后可继续填写', async ({page}) => {
  const state = await fixture(page, {model: {apiKeyConfigured: false}, feedbackError: true, feedback: {configured: false}});
  await page.goto('/public/home.html'); await expect(page.locator('#setup-title')).toContainText('AI 模型');
  await page.locator('#setup-key').fill('onboarding-model-fixture'); await page.locator('#setup-save').click();
  await expect(page.locator('#setup-title')).toContainText('问卷'); await expect(page.locator('#setup-url')).toBeDisabled();
  await expect(page.locator('#setup-missing')).toContainText('读取失败');
  state.feedbackError = false;
  await page.locator('#setup-retry').click(); await expect(page.locator('#setup-url')).toBeEnabled();
  await page.locator('#setup-key').fill('onboarding-provider-fixture'); await page.locator('#setup-save').click();
  await expect(page.locator('.api-setup')).not.toBeVisible();
});

test('配置冲突重新检测保留未保存输入，更新版本后才能重新保存', async ({page}) => {
  const state = await fixture(page, {model: {apiKeyConfigured: false}, conflict: true});
  await page.goto('/public/index.html'); await expect(page.locator('.api-setup')).toBeVisible();
  await page.locator('#setup-model').fill('my-unsaved-model'); await page.locator('#setup-key').fill('onboarding-model-fixture');
  await page.locator('#setup-save').click(); await expect(page.locator('#setup-status')).toContainText('其他页面');
  await expect(page.locator('#setup-url')).toBeDisabled();
  await page.locator('#setup-retry').click(); await expect(page.locator('#setup-url')).toBeEnabled();
  await expect(page.locator('#setup-model')).toHaveValue('my-unsaved-model'); await expect(page.locator('#setup-key')).toHaveValue('onboarding-model-fixture');
  await expect(page.locator('#setup-missing')).toContainText('输入仍保留');
  await page.locator('#setup-save').click(); await expect(page.locator('.api-setup')).not.toBeVisible();
  expect(state.posts.model[1].revision).toBe(state.posts.model[0].revision + 1);
  expect(state.model.model).toBe('my-unsaved-model');
});

test('连接测试可取消，失败后保留输入并允许重试', async ({page}) => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const state = await fixture(page, {model: {apiKeyConfigured: false}, testGate: gate});
  try {
    await page.goto('/public/index.html'); await expect(page.locator('.api-setup')).toBeVisible();
    await page.locator('#setup-key').fill('onboarding-model-fixture');
    await page.locator('#setup-test').click(); await expect(page.locator('#setup-cancel-request')).toBeVisible();
    await page.locator('#setup-cancel-request').click(); await expect(page.locator('#setup-status')).toContainText('已取消测试');
    await expect(page.locator('#setup-key')).toHaveValue('onboarding-model-fixture'); expect(state.posts.model).toHaveLength(0);
    state.testGate = null; state.testError = true; release();
    await page.locator('#setup-test').click(); await expect(page.locator('#setup-status')).toContainText('连接失败');
    await expect(page.locator('#setup-key')).toHaveValue('onboarding-model-fixture');
    state.testError = false;
    await page.locator('#setup-test').click(); await expect(page.locator('#setup-status')).toContainText('连接成功');
  } finally { release(); }
});

test('手机引导无横向溢出，键盘可退出，多次打开不会叠加弹窗或留存密钥', async ({page}) => {
  await fixture(page, {model: {apiKeyConfigured: false}}); await page.setViewportSize({width: 390, height: 844});
  await page.goto('/public/index.html'); await expect(page.locator('.api-setup')).toBeVisible();
  await page.locator('#setup-key').fill('onboarding-model-fixture'); await page.locator('#setup-show-key').click();
  await expect(page.locator('#setup-key')).toHaveAttribute('type', 'text');
  await page.screenshot({path: 'artifacts/setup-mobile.png'});
  expect(await page.locator('.api-setup').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('.api-setup')).not.toBeVisible();
  await expect(page.locator('#setup-key')).toHaveValue(''); await expect(page.locator('#setup-key')).toHaveAttribute('type', 'password');
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', {name: '补齐配置'}).click(); await expect(page.locator('.api-setup')).toBeVisible();
    await expect(page.locator('#setup-key')).toHaveValue('');
    await page.locator('#setup-skip').click(); await expect(page.locator('.api-setup')).not.toBeVisible();
  }
  await expect(page.locator('.api-setup')).toHaveCount(1);
});

test('在另一标签的完整设置页保存后，原页面自动更新配置提醒', async ({page}) => {
  await fixture(page, {model: {apiKeyConfigured: false}});
  await page.goto('/public/index.html'); await expect(page.locator('.api-setup')).toBeVisible();
  await page.locator('#setup-skip').click(); await expect(page.locator('.setup-reminder')).toBeVisible();
  const settings = await page.context().newPage();
  await settings.goto('/public/settings.html'); await expect(settings.locator('#settings-fields')).toBeEnabled();
  await settings.locator('#api-key').fill('onboarding-model-fixture'); await settings.locator('#save-model').click();
  await expect(settings.locator('#notice')).toContainText('已保存并生效');
  await expect(page.locator('.setup-reminder')).toBeHidden(); await expect(page.locator('.api-setup')).not.toBeVisible();
  await settings.close(); await page.bringToFront(); await page.reload(); await expect(page.locator('#save-status')).not.toHaveText('正在恢复…');
  await expect(page.locator('.api-setup')).toHaveCount(0);
});

test('检测超时后可跳过并重试，慢接口不会造成重复弹窗', async ({page}) => {
  await fixture(page, {model: {apiKeyConfigured: false}});
  let release; const gate = new Promise(resolve => {release = resolve;});
  const delayed = async route => {await gate; await route.abort('timedout').catch(() => {});};
  await page.route('**/api/model-settings', delayed);
  try {
    await page.goto('/public/index.html');
    await expect(page.locator('#setup-missing')).toContainText('读取失败', {timeout: 20000});
    await expect(page.locator('#setup-url')).toBeDisabled(); await expect(page.locator('#setup-skip')).toBeEnabled();
    release(); await page.unroute('**/api/model-settings', delayed);
    await page.locator('#setup-retry').click(); await expect(page.locator('#setup-key')).toBeEnabled();
    await expect(page.locator('#setup-key')).toBeFocused(); await expect(page.locator('.api-setup')).toHaveCount(1);
  } finally {release();}
});

test('恢复提醒在首页正常显示，不影响缺失配置检测', async ({page}) => {
  const state = await fixture(page, {model: {apiKeyConfigured: false}});
  await page.route('**/api/model-settings', route => route.fulfill({headers: {'X-Data-Recovery': 'previous-save-restored'}, json: state.model}));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/public/home.html'); await expect(page.locator('#setup-title')).toContainText('AI 模型');
  await expect(page.locator('#notice')).toContainText('恢复上一份有效保存'); await expect(page.locator('#notice')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('保存响应丢失后先检测确认，保留输入且不重复保存', async ({page}) => {
  const state = await fixture(page, {model: {apiKeyConfigured: false}});
  await page.route('**/api/model-settings', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.model = {...state.model, revision: state.model.revision + 1, apiKeyConfigured: true};
    await route.abort('failed');
  });
  await page.goto('/public/index.html'); await expect(page.locator('.api-setup')).toBeVisible();
  await page.locator('#setup-key').fill('onboarding-model-fixture'); await page.locator('#setup-save').click();
  await expect(page.locator('#setup-status')).toContainText('未能确认保存结果'); await expect(page.locator('#setup-save')).toBeDisabled();
  await page.locator('#setup-retry').click(); await expect(page.locator('#setup-key')).toHaveValue('onboarding-model-fixture');
  await expect(page.locator('#setup-missing')).toContainText('输入仍保留'); expect(state.posts.model).toHaveLength(0);
});

test('检测失败重试后已配置可直接关闭，后续凭据缺失仍能重新引导', async ({page}) => {
  const state = await fixture(page, {modelError: true});
  await page.goto('/public/index.html'); await expect(page.locator('#setup-missing')).toContainText('读取失败');
  state.modelError = false;
  await page.locator('#setup-retry').click(); await expect(page.locator('.api-setup')).not.toBeVisible();
  state.model.apiKeyConfigured = false;
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {key: 'connection-settings-updated'})));
  await expect(page.locator('.api-setup')).toBeVisible(); await expect(page.locator('#setup-key')).toBeEnabled();
});
