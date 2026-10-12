import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { ModelSettings } from '../src/modelSettings.js';
import { generateChatCandidate } from '../src/model.js';
import { emptyWorkspace, createResource, currentVersion } from '../src/workspace.js';

const root = new URL('..', import.meta.url).pathname;
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const base = 'http://127.0.0.1:3000', dir = path.join(root, 'artifacts/model-settings');
await fs.mkdir(dir, { recursive: true });
const hash = async name => createHash('sha256').update(await fs.readFile(path.join(root, 'data', name + '.json'))).digest('hex');
const before = { workspace: await hash('workspace'), classroom: await hash('classroom') };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], networkChecks = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/public/settings.html');
  await page.locator('#settings-fields:not([disabled])').waitFor();
  if (await page.locator('#api-key').inputValue()) throw new Error('已保存密钥不应回显');
  const visible = await (await fetch(base + '/api/model-settings')).json();
  if ('apiKey' in visible || !visible.apiKeyConfigured) throw new Error('密钥状态异常');
  await page.locator('#test-model').click();
  await page.locator('#test-result').filter({ hasText: '连接成功' }).waitFor({ timeout: visible.timeoutMs + 5000 });
  const connection = await page.locator('#test-result').textContent();
  for (const url of ['/data/model-settings.json', '/src/modelSettings.js', '/.env']) {
    const response = await fetch(base + url); if (response.status !== 403) throw new Error('私有文件可访问：' + url);
    networkChecks.push({ url, status: response.status });
  }
  await page.screenshot({ path: path.join(dir, 'settings-desktop.png'), fullPage: true });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(base + '/public/settings.html');
  await mobile.locator('#settings-fields:not([disabled])').waitFor();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error('设置页在手机宽度横向溢出');
  await mobile.screenshot({ path: path.join(dir, 'settings-mobile.png'), fullPage: true });
  // An actual model call checks the editable strategy and >15 pages in memory;
  // it never replaces or appends to the teacher's live workspace.
  const config = await new ModelSettings(path.join(root, 'data')).read();
  config.prompts.preparation = '教师自定义策略：这次新建恰好18页排序入门课件，每页一个具体教学主题，一至两个简短要点，备注可为空。按顺序讲解基础、原理、示例、操作练习和总结。不以15页为上限。本次是程序连接与配置验证，保持内容简洁。';
  const isolated = emptyWorkspace(); isolated.requirements = { topic: '排序入门', audience: '本科生', duration: 90, instructions: '按自定义提示词生成18页' };
  const candidate = await generateChatCandidate(isolated, '新建排序入门PPT，恰好18页。', null, null, undefined, config);
  if (candidate.action !== 'create' || candidate.type !== 'ppt') throw new Error('真实模型没有返回PPT新建成果');
  const resource = createResource(isolated, candidate.type, candidate.name, candidate.content);
  const pages = currentVersion(resource).content.slides.length;
  if (pages < 18) throw new Error('真实模型仍未生成要求的18页');
  await fs.writeFile(path.join(dir, 'real-model-candidate.json'), JSON.stringify(candidate, null, 2));
  const after = { workspace: await hash('workspace'), classroom: await hash('classroom') };
  const result = { checkedAt: new Date().toISOString(), model: visible.model, keyConfigured: visible.apiKeyConfigured,
    connection, realModelPages: pages, networkChecks, mobileOverflow: overflow, browserErrors: errors, before, after,
    workspaceUnchanged: before.workspace === after.workspace, classroomUnchanged: before.classroom === after.classroom };
  await fs.writeFile(path.join(dir, 'live-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || !result.workspaceUnchanged || !result.classroomUnchanged) throw new Error('浏览器错误或正式数据变化，须复核');
} finally { await browser.close(); }
