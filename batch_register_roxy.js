const { chromium } = require('playwright');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ==================== 读取配置 ====================
function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('缺少 config.json，请先创建配置文件');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  return raw;
}

const config = loadConfig();

const ROXY = {
  apiBase: config.roxy.apiBase || 'http://127.0.0.1:50000',
  token: config.roxy.token,
  workspaceId: config.roxy.workspaceId,
};

const MAIL = {
  apiBase: config.mail.apiBase,
  adminPassword: config.mail.adminPassword,
  domains: config.mail.domains,
};

const CFG = {
  code: config.register.affiliateCode || 'YT Affiliate',
  affUrl: `https://openart.ai/credit/${encodeURIComponent(config.register.affiliateCode || 'YT Affiliate')}`,
  signupUrl: 'https://openart.ai/signup',
  count: config.register.count || 1,
  concurrency: config.register.concurrency || 1,
  waitForUserTurnstile: true,
  turnstileTimeout: (config.register.turnstileTimeout || 120) * 1000,
};

// ==================== TLS & HTTP ====================
const agent = new https.Agent({ rejectUnauthorized: false });
const ax = { httpsAgent: agent, timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } };

// ==================== Roxy API 封装 ====================
function roxyHeaders() {
  return { token: ROXY.token, 'Content-Type': 'application/json' };
}

async function roxyGet(path, params = {}) {
  const url = `${ROXY.apiBase}${path}`;
  const qs = new URLSearchParams(params).toString();
  const resp = await axios.get(qs ? `${url}?${qs}` : url, { ...ax, headers: roxyHeaders() });
  return resp.data;
}

async function roxyPost(path, body = {}) {
  const resp = await axios.post(`${ROXY.apiBase}${path}`, body, { ...ax, headers: roxyHeaders() });
  return resp.data;
}

// Roxy API 方法
async function roxyListProfiles() {
  const r = await roxyGet('/browser/list_v3', { workspaceId: ROXY.workspaceId });
  if (r.code !== 0) throw new Error('获取窗口列表失败: ' + r.msg);
  return r.data?.rows || r.data || [];
}

async function roxyCreateProfile(name) {
  const r = await roxyPost('/browser/create', {
    workspaceId: ROXY.workspaceId,
    windowName: name,
  });
  if (r.code !== 0) throw new Error('创建窗口失败: ' + r.msg);
  return r.data?.dirId || r.data?.id;
}

async function roxyOpenBrowser(dirId) {
  const r = await roxyPost('/browser/open', {
    workspaceId: ROXY.workspaceId,
    dirId: dirId,
    forceOpen: false,
    headless: false,
  });
  if (r.code !== 0 && r.code !== 500) throw new Error('打开浏览器失败: ' + r.msg);
  // code=500 可能表示已打开
  return r.data;
}

async function roxyCloseBrowser(dirId) {
  return roxyPost('/browser/close', {
    workspaceId: ROXY.workspaceId,
    dirIds: [dirId],
  });
}

async function roxyDeleteProfile(dirId) {
  return roxyPost('/browser/delete', {
    workspaceId: ROXY.workspaceId,
    dirIds: [dirId],
  });
}

// ==================== Cloudflare 邮箱 ====================
let di = 0;
function nd() { return MAIL.domains[di++ % MAIL.domains.length]; }

async function createMail() {
  const name = crypto.randomBytes(5).toString('hex');
  const r = await axios.post(`${MAIL.apiBase}/admin/new_address`,
    { enablePrefix: true, name, domain: nd() },
    { ...ax, headers: { ...ax.headers, 'Content-Type': 'application/json', 'x-admin-auth': MAIL.adminPassword } });
  if (!r.data.address || !r.data.jwt) throw new Error('邮箱创建失败');
  return r.data;
}

// 用 JWT 查询指定邮箱的邮件（跟 Python CloudflareTempMailProvider 一样）
async function waitCode(targetEmail, jwt, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await axios.get(`${MAIL.apiBase}/api/mails`, {
        httpsAgent: agent, timeout: 15000,
        headers: { Authorization: `Bearer ${jwt}`, 'User-Agent': 'Mozilla/5.0' },
        params: { limit: 10, offset: 0 }
      });
      const msgs = r.data.results || [];
      for (const m of msgs) {
        // 用 raw 字段 (subject/text/html 在 /api/mails 响应中可能为空)
        const raw = m.raw || '';
        const subject = m.subject || (raw.match(/^Subject: (.+)$/m) || [])[1] || '';
        const content = subject + '\n' + (m.text || '') + '\n' + (m.html || '') + '\n' + raw;
        if (!content.trim()) continue;

        // 跟 Python _extract_code 一样的提取逻辑
        let match = content.match(/(?:verification code|code is|代码为|验证码)[:\s]*(\d{6})/i);
        if (match && match[1] !== '177010') return match[1];

        const gtMatches = content.match(/>\s*(\d{6})\s*</g);
        if (gtMatches) {
          for (const gm of gtMatches) {
            const code = (gm.match(/\d{6}/) || [])[0];
            if (code && code !== '177010') return code;
          }
        }

        match = content.match(/(?<![#&])\b(\d{6})\b/);
        if (match && match[1] !== '177010') return match[1];
      }
      process.stdout.write('.');
    } catch (e) {
      // 前面几次错误输出帮助调试
      const elapsed = Date.now() - start;
      if (elapsed < 15000) console.log(`  邮箱轮询错误(${(elapsed/1000).toFixed(0)}s): ${e.response?.status || e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('验证码超时');
}

// ==================== 工具 ====================
const sleep = ms => new Promise(r => setTimeout(r, ms));
function genPw() {
  const u = 'ABCDEFGHJKLMNPQRSTUVWXYZ', l = 'abcdefghjkmnpqrstuvwxyz', d = '23456789', s = '!@#$%', a = u + l + d + s;
  let pw = u[crypto.randomInt(u.length)] + l[crypto.randomInt(l.length)] + d[crypto.randomInt(d.length)] + s[crypto.randomInt(s.length)];
  for (let i = 0; i < 12; i++) pw += a[crypto.randomInt(a.length)];
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ==================== 单账号注册（使用 Roxy 浏览器窗口） ====================
async function registerOne(index, total, dirId) {
  const tag = `[${index + 1}/${total}]`;

  // 1. 通过 Roxy API 打开浏览器窗口
  console.log(`${tag} 通过 Roxy 打开浏览器窗口...`);
  let openResult;
  try {
    openResult = await roxyOpenBrowser(dirId);
  } catch (e) {
    console.log(`${tag} 打开窗口失败: ${e.message}`);
    // 可能已打开，尝试获取连接信息
    openResult = null;
  }

  // 2. 获取 CDP WebSocket 地址
  let wsEndpoint = openResult?.ws;
  if (!wsEndpoint) {
    // 通过 connection_info 查找
    const connInfo = await roxyGet('/browser/connection_info', { workspaceId: ROXY.workspaceId });
    const conns = connInfo.data || [];
    const match = conns.find(c => c.dirId === dirId || c.windowId === dirId);
    if (match?.ws) wsEndpoint = match.ws;
  }

  if (!wsEndpoint) {
    throw new Error('无法获取浏览器 WebSocket 连接地址（可能需要先打开窗口）');
  }

  console.log(`${tag} CDP: ${wsEndpoint}`);

  // 3. 通过 Playwright CDP 连接到 Roxy 打开的浏览器
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const contexts = browser.contexts();
  // 使用新页面，避免已有页面的状态干扰
  const page = await contexts[0].newPage();

  let email = '', password = '';

  try {
    // 4. 创建邮箱
    console.log(`${tag} 创建邮箱...`);
    const mailbox = await createMail();
    email = mailbox.address; password = genPw();
    console.log(`${tag} ${email}  |  ${password}`);

    // 5. 访问邀请页
    await page.goto(CFG.affUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(2000);

    // 6. 注册页
    await page.goto(`${CFG.signupUrl}?callbackUrl=/credit/${encodeURIComponent(CFG.code)}`, {
      waitUntil: 'domcontentloaded', timeout: 40000,
    });
    await sleep(4000);

    // 7. 填写表单
    console.log(`${tag} 填写表单...`);
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    const ei = page.locator('input[type="email"]');
    await ei.click(); await sleep(300);
    for (const ch of email) { await page.keyboard.insertText(ch); await sleep(50 + Math.random() * 80); }

    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).click(); await sleep(300);
    for (const ch of password) { await page.keyboard.insertText(ch); await sleep(40 + Math.random() * 70); }
    await pwInputs.nth(1).click(); await sleep(300);
    for (const ch of password) { await page.keyboard.insertText(ch); await sleep(40 + Math.random() * 70); }
    await sleep(500);

    // 8. 点击 Sign Up
    console.log(`${tag} 点击 Sign Up...`);
    const btn = page.locator('button:has-text("Sign Up")');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();

    if (CFG.waitForUserTurnstile) {
      console.log(`${tag} === 请在 Roxy 浏览器窗口中手动完成 Turnstile 验证 ===`);
      console.log(`${tag} 等待 Turnstile 解决...`);
      // 等待 cf-turnstile-response 获得值，表示用户解决了验证
      const tsStart = Date.now();
      while (Date.now() - tsStart < 120000) {
        const tsVal = await page.$eval('input[name="cf-turnstile-response"]', el => el.value).catch(() => '');
        if (tsVal && tsVal.length > 10) {
          console.log(`${tag} Turnstile 已解决!`);
          break;
        }
        await sleep(2000);
      }
    }

    // 9. 等待验证码输入框
    const startWait = Date.now();
    let codeInputFound = false;
    while (Date.now() - startWait < 180000) {
      const inputs = page.locator('input');
      const count = await inputs.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const ml = await inputs.nth(i).getAttribute('maxlength').catch(() => '');
        if (ml === '1') { codeInputFound = true; break; }
        const type = await inputs.nth(i).getAttribute('type').catch(() => '') || '';
        const ph = await inputs.nth(i).getAttribute('placeholder').catch(() => '') || '';
        if ((type === 'text' || type === 'number' || type === 'tel') && ph && !ph.includes('Email') && !ph.includes('Password')) { codeInputFound = true; break; }
      }
      if (codeInputFound) break;
      await sleep(2000);
    }
    if (!codeInputFound) throw new Error('等待验证码输入超时');

    // 10. 获取验证码
    console.log(`${tag} 获取验证码...`);
    const code = await waitCode(email, mailbox.jwt, 180000);
    console.log(`${tag} 验证码: ${code}`);

    // 11. 填入验证码
    const allInputs = page.locator('input');
    const ic = await allInputs.count();
    const digits = code.split('');
    const otpInputs = [];
    for (let i = 0; i < ic; i++) {
      const ml = await allInputs.nth(i).getAttribute('maxlength').catch(() => '');
      if (ml === '1') otpInputs.push(allInputs.nth(i));
    }
    if (otpInputs.length >= 6) {
      for (let i = 0; i < 6; i++) { await otpInputs[i].fill(digits[i]); await sleep(50); }
    } else {
      for (let i = 0; i < ic; i++) {
        const type = await allInputs.nth(i).getAttribute('type').catch(() => '') || '';
        const ph = await allInputs.nth(i).getAttribute('placeholder').catch(() => '') || '';
        if ((type === 'text' || type === 'number' || type === 'tel') && ph && !ph.includes('Email') && !ph.includes('Password')) { await allInputs.nth(i).fill(code); break; }
      }
    }
    console.log(`${tag} 验证码已填入`);

    // 12. 验证按钮
    await sleep(500);
    for (const sel of ['button:has-text("Verify")', 'button:has-text("Continue")', 'button:has-text("Submit")']) {
      const b = page.locator(sel).first();
      if (await b.isVisible({ timeout: 2000 }).catch(() => false)) {
        if (!(await b.isDisabled().catch(() => true))) { await b.click(); console.log(`${tag} 已点击验证`); break; }
      }
    }

    // 13. 等待注册完成
    await sleep(5000);
    try { await page.waitForURL(u => !u.pathname.includes('/signup'), { timeout: 30000 }); } catch {}
    console.log(`${tag} URL: ${page.url()}`);

    // 14. 领取积分
    await sleep(3000);
    await page.goto(CFG.affUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(4000);
    let claimed = false;
    for (const sel of ['button:has-text("Claim Credits")', 'button:has-text("Claim")']) {
      const b = page.locator(sel).first();
      if (await b.isVisible({ timeout: 3000 }).catch(() => false)) {
        if (!(await b.isDisabled().catch(() => true))) { await b.click(); console.log(`${tag} 已领取`); await sleep(5000); claimed = true; break; }
      }
    }
    console.log(`${tag} 完成! claimed=${claimed}`);
    return { email, password, claimed, timestamp: new Date().toISOString() };

  } catch (err) {
    console.error(`${tag} 失败: ${err.message}`);
    return { email: email || 'unknown', password: password || 'unknown', claimed: false, error: err.message, timestamp: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ==================== 主流程 ====================
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  OpenArt 批量注册 - Roxy 浏览器     ║');
  console.log('║  码: YT Affiliate | Workspace: 97119║');
  console.log(`║  数量: ${CFG.count}                          ║`);
  console.log('╚══════════════════════════════════════╝\n');

  // 1. 获取现有的浏览器窗口列表
  console.log('获取 Roxy 浏览器窗口列表...');
  let profiles = await roxyListProfiles();
  console.log(`找到 ${profiles.length} 个已有窗口`);

  // 2. 为每个注册任务准备窗口（逐个创建，用完即删）
  const runId = Date.now();
  const needed = CFG.count;
  while (profiles.length < needed) {
    const idx = profiles.length + 1;
    const name = `OpenArt_${runId}_${idx}`;
    console.log(`创建新窗口: ${name}`);
    const dirId = await roxyCreateProfile(name);
    profiles = await roxyListProfiles();
    console.log(`创建完成: ${dirId}, 当前共 ${profiles.length} 个窗口`);
  }

  // 3. 并行批量注册
  const results = [];
  const batchSize = Math.min(CFG.concurrency, needed);

  for (let batchStart = 0; batchStart < needed; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, needed);
    const batchIndexes = Array.from({ length: batchEnd - batchStart }, (_, j) => batchStart + j);
    const batchProfiles = batchIndexes.map(j => profiles[j]);

    console.log(`\n=== 批次 ${Math.floor(batchStart / batchSize) + 1}: ${batchIndexes.length} 个并行 ===`);

    // 并行执行
    const batchResults = await Promise.all(
      batchIndexes.map(async (idx, bj) => {
        const dirId = typeof batchProfiles[bj] === 'string' ? batchProfiles[bj] : (batchProfiles[bj].dirId || batchProfiles[bj].id);
        const result = await registerOne(idx, needed, dirId);

        // 关闭并删除
        try { await roxyCloseBrowser(dirId); } catch (e) { console.log(`  关闭失败(${dirId.slice(-6)}): ${e.message}`); }
        await sleep(2000);
        try { await roxyDeleteProfile(dirId); console.log(`  已删除 ${dirId.slice(-6)}`); } catch (e) { console.log(`  删除失败(${dirId.slice(-6)}): ${e.message}`); }
        return result;
      })
    );
    results.push(...batchResults);

    // 批次间随机等待
    if (batchEnd < needed) {
      const wait = 5000 + Math.random() * 20000;
      console.log(`\n等待 ${(wait / 1000).toFixed(1)}s...\n`);
      await sleep(wait);
    }
  }

  // 4. 汇总和导出
  const ok = results.filter(r => r.claimed);
  const fail = results.filter(r => !r.claimed);
  console.log('\n' + '='.repeat(60));
  console.log(`  成功: ${ok.length}  失败: ${fail.length}`);
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`  [${r.claimed ? '+' : '-'}] ${r.email} | ${r.password}`);
    if (r.error) console.log(`       错误: ${r.error}`);
  }

  // 导出账号密码到文件
  const ts = Date.now();

  // JSON 完整导出
  const jsonFile = path.join(__dirname, `accounts_${ts}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(results, null, 2));

  // 纯文本导出 — 格式: 邮箱----密码
  const txtFile = path.join(__dirname, `accounts_${ts}.txt`);
  const successLines = [];
  const failLines = [];
  for (const r of results) {
    if (r.claimed) {
      successLines.push(`${r.email}----${r.password}`);
    } else {
      failLines.push(`${r.email}----${r.password} (失败: ${r.error || '未知'})`);
    }
  }
  const txtContent = [
    `# OpenArt 注册结果 ${new Date().toISOString()}`,
    `# 成功: ${ok.length}  失败: ${fail.length}`,
    '',
    ...successLines,
    ...(failLines.length > 0 ? ['', '# 以下失败:', ...failLines] : []),
  ].join('\n');
  fs.writeFileSync(txtFile, txtContent);

  console.log(`\nJSON: ${jsonFile}`);
  console.log(`TXT:  ${txtFile}`);
}

main().catch(console.error);
