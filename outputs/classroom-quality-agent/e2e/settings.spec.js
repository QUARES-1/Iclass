import { test, expect } from '@playwright/test';

test('教师配置模型、提示词、额度，测试不自动保存，刷新可恢复且密钥不回显', async ({ page, request }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const original = await (await request.get('/api/model-settings')).json();
  try {
    await page.goto('/public/settings.html'); await expect(page.locator('#settings-fields')).toBeEnabled();
    await expect(page.locator('#api-key')).toHaveValue(''); await expect(page.locator('#key-status')).toContainText('已配置');
    await page.locator('#model').fill('teacher-browser-model'); await page.locator('#max-tokens').fill('12000');
    await page.locator('#prompt-preparation').fill('教师自定义：不限制课件页数，详解原理，安排可实操练习。');
    await page.locator('#test-model').click(); await expect(page.locator('#test-result')).toContainText('连接成功');
    await expect(page.locator('#test-result')).toContainText('尚未保存');
    expect((await (await request.get('/api/model-settings')).json()).model).toBe(original.model);
    await page.locator('#save-model').click(); await expect(page.locator('#notice')).toContainText('已保存并生效');
    await page.reload(); await expect(page.locator('#model')).toHaveValue('teacher-browser-model');
    await expect(page.locator('#prompt-preparation')).toHaveValue('教师自定义：不限制课件页数，详解原理，安排可实操练习。');
    await expect(page.locator('#max-tokens')).toHaveValue('12000'); await expect(page.locator('#api-key')).toHaveValue('');
    const status = await (await request.get('/api/status')).json(); expect(status.model).toBe('teacher-browser-model');
    await page.locator('[data-reset="preparation"]').click(); await expect(page.locator('#save-status')).toContainText('未保存');
    await expect(page.locator('#prompt-preparation')).toHaveValue(original.defaults.prompts.preparation);
    page.once('dialog', dialog => dialog.accept()); await page.locator('#reload-model').click();
    await expect(page.locator('#prompt-preparation')).toHaveValue('教师自定义：不限制课件页数，详解原理，安排可实操练习。');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#prompt-group-classroom > summary').click();await page.locator('#prompt-classroom').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const actionBar=page.locator('.settings-actions');await expect(actionBar).toBeInViewport();
    await page.locator('#prompt-classroom').fill('手机编辑的课堂复盘提示词。');
    await page.locator('#save-model').click();await expect(page.locator('#notice')).toContainText('已保存并生效');
    expect((await(await request.get('/api/model-settings')).json()).prompts.classroom).toBe('手机编辑的课堂复盘提示词。');
    expect(errors).toEqual([]);
  } finally {
    const current = await (await request.get('/api/model-settings')).json();
    await request.post('/api/model-settings', { data: { revision: current.revision, baseUrl: original.baseUrl, model: original.model, maxTokens: original.maxTokens, temperature: original.temperature, timeoutMs: original.timeoutMs, maxInputChars: original.maxInputChars, prompts: original.prompts } });
  }
});

test('配置冲突保留当前输入，密钥可替换和清除，清除后状态即时更新', async ({ page, request }) => {
  const original = await (await request.get('/api/model-settings')).json();
  try {
    await page.goto('/public/settings.html'); await expect(page.locator('#settings-fields')).toBeEnabled();
    await page.locator('#api-key').fill('browser-settings-only-key');
    await page.locator('#show-key').click(); await expect(page.locator('#api-key')).toHaveAttribute('type', 'text');
    await page.locator('#save-model').click(); await expect(page.locator('#notice')).toContainText('已保存并生效');
    await expect(page.locator('#api-key')).toHaveValue(''); await expect(page.locator('#api-key')).toHaveAttribute('type', 'password');
    let saved = await (await request.get('/api/model-settings')).json(); expect(saved.apiKey).toBeUndefined(); expect(saved.apiKeyConfigured).toBe(true);
    await page.locator('#prompt-preparation').fill('此处未保存的教师提示词，发生冲突仍须保留。');
    await request.post('/api/model-settings', { data: { revision: saved.revision, model: 'other-tab-model' } });
    await page.locator('#save-model').click(); await expect(page.locator('#notice')).toContainText('其他操作');
    await expect(page.locator('#prompt-preparation')).toHaveValue('此处未保存的教师提示词，发生冲突仍须保留。');
    page.once('dialog', dialog => dialog.accept()); await page.locator('#reload-model').click();
    await expect(page.locator('#model')).toHaveValue('other-tab-model');
    await page.locator('#clear-key').check(); await expect(page.locator('#api-key')).toBeDisabled();
    await page.locator('#save-model').click(); await expect(page.locator('#key-status')).toContainText('尚未配置');
    await expect(page.locator('#api-key')).toBeEnabled();
    expect((await (await request.get('/api/status')).json()).textModelConfigured).toBe(false);
  } finally {
    const current = await (await request.get('/api/model-settings')).json();
    await request.post('/api/model-settings', { data: { revision: current.revision, apiKey: 'browser-test-fixture', baseUrl: original.baseUrl, model: original.model, maxTokens: original.maxTokens, temperature: original.temperature, timeoutMs: original.timeoutMs, maxInputChars: original.maxInputChars, prompts: original.prompts } });
  }
});

test('教师手动扩写自动分页，预览、教师备注和PPTX实际页数一致', async ({ page, request }) => {
  let state = await (await request.get('/api/workspace')).json();
  await request.post('/api/workspace', { data: { revision: state.revision, action: 'clear' } });
  await page.goto('/public/index.html'); await expect(page.locator('#save-status')).toContainText(/已保存|已恢复/);
  await expect(page.getByRole('link', { name: '模型与提示词设置' })).toHaveAttribute('target', '_blank');
  await page.locator('#request').fill('新建排序PPT'); await page.locator('#send').click();
  await expect(page.locator('#review-list .slide-card')).toHaveCount(3);
  const first = page.locator('#review-list .slide-card').first();
  await first.locator('summary').click();
  const bullets = Array.from({ length: 13 }, (_, i) => '详细可执行步骤 ' + i);
  await first.locator('[data-field="bullets"]').fill(bullets.join('\n'));
  await first.locator('[data-save-slide]').click();
  await expect(page.locator('#review-list .slide-card')).toHaveCount(6);
  state = await (await request.get('/api/workspace')).json();
  const resource = state.resources.find(r => r.id === state.selectedId), version = resource.versions.find(v => v.id === resource.currentVersionId);
  expect(version.content.slides.slice(0, 4).flatMap(s => s.bullets)).toEqual(bullets);
  expect(version.content.slides.slice(0, 4).every(s => s.notes.includes('教师备注'))).toBe(true);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-draft').click()]);
  const file = await download.path();
  // Check the actual ZIP presentation entries, not just the preview count.
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(file), names = bytes.toString('latin1').match(/ppt\/slides\/slide\d+\.xml\b/g) || [];
  expect(new Set(names).size).toBe(6);
});
