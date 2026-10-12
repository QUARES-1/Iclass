import { renderActivity } from './interactive.js';
import { AppError } from './store.js';

// Validate executable behavior before an AI activity is committed. Each check
// runs in its own browser process, so a failed preview can always be terminated.
export async function checkActivityRuntime(content) {
  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ channel: process.env.PREVIEW_BROWSER || 'chrome', headless: true, timeout: 15000 });
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.setContent(renderActivity(content), { waitUntil: 'load', timeout: 5000 });
    if (content.mode === 'quiz') {
      for (const q of content.questions) {
        const options = page.locator('#activity button:not([data-next])');
        const wrong = q.answer === 0 ? 1 : 0;
        await options.nth(wrong).click();
        if (!(await page.locator('#feedback').textContent()).includes('不正确')) throw new Error('错误选项无有效反馈。');
        await options.nth(q.answer).click();
        if (await page.locator('#feedback').getAttribute('data-ok') !== 'true') throw new Error('正确答案未通过。');
        await page.locator('[data-next]').click();
      }
    } else if (content.mode === 'order') {
      await page.getByRole('button', {name:'检查答案',exact:true}).click();
      if (await page.locator('#feedback').getAttribute('data-ok') === 'true') throw new Error('乱序初始化被错误判为正确。');
      if (content.rule === 'bubble') {
        for (let i = content.items.length - 2; i >= 0; i--) await page.locator('.item').nth(i).getByRole('button').click();
      } else {
        for (let i = content.items.length - 1; i > 0; i--) await page.locator('.item').nth(i).getByRole('button', { name:'↑',exact:true }).click();
      }
      await page.getByRole('button', {name:'检查答案',exact:true}).click();
      if (await page.locator('#feedback').getAttribute('data-ok') !== 'true') throw new Error('排序操作或答案判定错误。');
    } else if (content.mode === 'match') {
      for (const p of content.pairs) { await page.locator('.columns > div').nth(0).getByRole('button',{name:p.left,exact:true}).click(); await page.locator('.columns > div').nth(1).getByRole('button',{name:p.right,exact:true}).click(); }
      if (!(await page.locator('#feedback').textContent()).includes('全部配对完成')) throw new Error('配对未完成。');
    } else {
      for (let i = 1; i < content.items.length; i++) await page.getByRole('button',{name:'下一步',exact:true}).click();
      await page.getByRole('button',{name:'完成演示',exact:true}).click();
      if (await page.locator('#feedback').getAttribute('data-ok') !== 'true') throw new Error('步骤演示未完成。');
    }
    await page.locator('#hint').click();
    if (await page.locator('#feedback').textContent() !== content.hint) throw new Error('操作提示与内容不一致。');
    await page.locator('#reset').click();
    if (await page.locator('#activity').textContent() === '') throw new Error('重置后活动为空。');
    if (errors.length) throw new Error(errors[0]);
    return { passed: true, browser: browser.version(), checked: ['initialization','operation','feedback','hint','reset','offline'] };
  } catch (error) { throw new AppError('互动候选运行检查未通过，原成果保留。' + error.message, 502); }
  finally { if (browser) await browser.close(); }
}
