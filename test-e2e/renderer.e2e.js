'use strict';
// 端到端 UI 测试：在真实 Electron 环境中启动应用（真实 main.js + preload.js + renderer.js + CSS），
// 通过 executeJavaScript 驱动界面交互并断言 DOM / 计算样式 / 落盘结果。
// 覆盖单元测试无法触及的渲染层：脚本能否加载、视图互斥、CSS [hidden] 是否生效、各功能交互流程。
//
// 运行：npm run test:e2e   （等价于 electron test-e2e/renderer.e2e.js）
const { app, BrowserWindow, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// 隔离运行环境与打桩（避免弹出原生对话框 / 污染真实剪贴板）
// ---------------------------------------------------------------------------
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-'));
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-files-'));
app.setPath('userData', userData);

const stubIO = { savePath: null, openPaths: null };
dialog.showSaveDialog = async () =>
  stubIO.savePath ? { canceled: false, filePath: stubIO.savePath } : { canceled: true };
dialog.showOpenDialog = async () =>
  stubIO.openPaths ? { canceled: false, filePaths: stubIO.openPaths } : { canceled: true };

const stubClip = { text: '' };
clipboard.writeText = (t) => { stubClip.text = t; };
clipboard.readText = () => stubClip.text;
clipboard.clear = () => { stubClip.text = ''; };

// 尽早挂上控制台监听，捕获渲染层加载期的报错（如语法错误）
const consoleErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (...args) => {
    let level, message, source, line;
    if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null) {
      ({ level, message, lineNumber: line, sourceId: source } = args[1]);
    } else {
      [, level, message, line, source] = args;
    }
    const isError = level === 'error' || level === 3 || /Uncaught/i.test(String(message));
    if (isError) consoleErrors.push(`${message} @${source}:${line}`);
  });
  wc.on('render-process-gone', (_e2, d) => consoleErrors.push('render-process-gone ' + JSON.stringify(d)));
  wc.on('preload-error', (_e3, p, err) => consoleErrors.push('preload-error ' + p + ' :: ' + err.message));
});

// 加载真实应用逻辑（注册 IPC 处理器并创建窗口）
require('../main.js');

// ---------------------------------------------------------------------------
// 简易断言框架
// ---------------------------------------------------------------------------
const results = [];
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed++;
  process.stdout.write(`  ${ok ? '✔' : '✖'} ${name}${!ok && detail ? '  → ' + detail : ''}\n`);
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function ok(name, cond, detail) {
  check(name, !!cond, detail);
}

const PASSWORD = 'master-1234';
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.hide();
  const ev = (js) => win.webContents.executeJavaScript(js);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(600); // 等待 bootstrap 完成

  // 注入页面辅助函数与 alert/confirm 桩
  await ev(`
    window.__q = (s) => document.querySelector(s);
    window.__click = (s) => { const el = __q(s); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; };
    window.__setval = (s,v) => { const el = __q(s); el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); return true; };
    window.__submit = (s) => { const el = __q(s); el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; };
    window.__txt = (s) => { const el = __q(s); return el ? el.textContent : null; };
    window.__val = (s) => { const el = __q(s); return el ? el.value : null; };
    window.__disp = (s) => { const el = __q(s); return el ? getComputedStyle(el).display : null; };
    window.__hid = (s) => { const el = __q(s); return el ? el.hidden : null; };
    window.__cnt = (s) => document.querySelectorAll(s).length;
    window.__sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); };
    window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    1
  `);

  const snap = () => ev(`({
    authHidden: __hid('#auth-view'), authDisplay: __disp('#auth-view'),
    mainHidden: __hid('#main-view'), mainDisplay: __disp('#main-view'),
    title: __txt('#auth-title'), hint: __txt('#auth-hint'), submitText: __txt('#auth-submit'),
    confirmHidden: __hid('#auth-confirm'), confirmDisplay: __disp('#auth-confirm'),
    err: __txt('#auth-error'), pwVal: __val('#auth-password')
  })`);

  try {
    // ======================= 1. 渲染层加载与初始状态 =======================
    process.stdout.write('\n[渲染层加载与初始状态]\n');
    let s = await snap();
    ok('renderer.js 完整执行（bootstrap 已运行，提示文字已渲染）', s.hint && s.hint.length > 0, JSON.stringify(s.hint));
    eq('创建模式：标题为「创建主密码」', s.title, '创建主密码');
    eq('创建模式：按钮为「创建保险库」', s.submitText, '创建保险库');
    ok('创建模式：确认密码框可见', s.confirmHidden === false && s.confirmDisplay !== 'none', `hidden=${s.confirmHidden} display=${s.confirmDisplay}`);

    // ======================= 2. 视图互斥 / CSS [hidden] 回归 =======================
    process.stdout.write('\n[视图互斥与 CSS [hidden] 生效（回归保护）]\n');
    ok('认证视图可见', s.authHidden === false && s.authDisplay !== 'none', `hidden=${s.authHidden} display=${s.authDisplay}`);
    check('主视图被隐藏：hidden 属性生效且计算 display 为 none', s.mainHidden === true && s.mainDisplay === 'none',
      `hidden=${s.mainHidden} display=${s.mainDisplay}`);

    // ======================= 3. 创建主密码校验 =======================
    process.stdout.write('\n[创建主密码校验]\n');
    await ev(`__setval('#auth-password','aaaa1'); __setval('#auth-confirm',''); __submit('#auth-form');`);
    await sleep(150);
    s = await snap();
    eq('确认密码为空 → 提示再次输入', s.err, '请再次输入确认密码');
    eq('校验失败时不清空主密码输入框', s.pwVal, 'aaaa1');

    await ev(`__setval('#auth-password','aaaa1'); __setval('#auth-confirm','bbbb2'); __submit('#auth-form');`);
    await sleep(150);
    s = await snap();
    eq('两次密码不一致 → 提示', s.err, '两次输入的密码不一致');
    eq('不一致时不清空主密码输入框', s.pwVal, 'aaaa1');

    await ev(`__setval('#auth-password','abc'); __setval('#auth-confirm','abc'); __submit('#auth-form');`);
    await sleep(150);
    eq('主密码过短 → 提示至少 4 位', (await snap()).err, '主密码至少需要 4 个字符');

    // ======================= 4. 创建成功 → 进入主视图 =======================
    process.stdout.write('\n[创建保险库并进入主视图]\n');
    await ev(`__setval('#auth-password','${PASSWORD}'); __setval('#auth-confirm','${PASSWORD}'); __submit('#auth-form');`);
    await sleep(700);
    s = await snap();
    check('创建成功后主视图可见', s.mainHidden === false && s.mainDisplay !== 'none', `hidden=${s.mainHidden} display=${s.mainDisplay}`);
    check('创建成功后认证视图被真正隐藏（display:none）', s.authHidden === true && s.authDisplay === 'none', `hidden=${s.authHidden} display=${s.authDisplay}`);
    eq('初始条目列表为空', await ev(`__cnt('#entry-list li')`), 0);
    eq('空状态提示可见', await ev(`__hid('#empty')`), false);

    // ======================= 5. 新建条目 =======================
    process.stdout.write('\n[条目管理：新建 / 列表 / 详情]\n');
    await ev(`__click('#btn-new')`);
    await sleep(100);
    eq('点击「新建条目」弹出编辑弹窗', await ev(`__hid('#entry-modal')`), false);
    await ev(`
      __setval('#entry-title','GitHub');
      __setval('#entry-username','me@a.com');
      __setval('#entry-password','p@ss');
      __setval('#entry-url','https://github.com');
      __setval('#entry-notes','hello');
      __submit('#entry-form');
    `);
    await sleep(400);
    eq('保存后弹窗关闭', await ev(`__hid('#entry-modal')`), true);
    eq('列表出现 1 条条目', await ev(`__cnt('#entry-list li')`), 1);
    ok('列表显示标题 GitHub', (await ev(`__q('#entry-list').textContent`)).includes('GitHub'), '');
    eq('条目存在时空状态提示被隐藏', await ev(`__hid('#empty')`), true);

    // ======================= 6. 选中条目 → 详情 / 复制 =======================
    await ev(`__q('#entry-list li').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(150);
    eq('选中后详情区显示', await ev(`__hid('#detail-content')`), false);
    ok('详情显示用户名', (await ev(`__q('#detail-content').textContent`)).includes('me@a.com'), '');
    ok('详情显示密码', (await ev(`__q('#detail-content').textContent`)).includes('p@ss'), '');

    await ev(`__q('#detail-content [data-copy="me@a.com"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(150);
    eq('复制用户名写入剪贴板', stubClip.text, 'me@a.com');

    // ======================= 7. 搜索过滤 =======================
    process.stdout.write('\n[搜索过滤]\n');
    await ev(`__setval('#search','git')`);
    await sleep(120);
    eq('关键字匹配时列表保留 1 条', await ev(`__cnt('#entry-list li')`), 1);
    await ev(`__setval('#search','zzzznomatch')`);
    await sleep(120);
    eq('无匹配时列表为空', await ev(`__cnt('#entry-list li')`), 0);
    eq('无匹配时显示空状态', await ev(`__hid('#empty')`), false);
    await ev(`__setval('#search','')`);
    await sleep(120);

    // ======================= 8. 密码生成器 =======================
    process.stdout.write('\n[密码生成器]\n');
    await ev(`__click('#btn-generator')`);
    await sleep(150);
    eq('点击「密码生成器」弹出弹窗', await ev(`__hid('#generator-modal')`), false);
    const gen1 = await ev(`__txt('#gen-output')`);
    ok('生成器输出密码', gen1 && gen1.length === 16, `length=${gen1 && gen1.length}`);
    ok('显示强度（bit）', /bit/.test(await ev(`__txt('#gen-bits')`)), '');
    await ev(`__setval('#gen-length','24'); __q('#gen-length').dispatchEvent(new Event('input',{bubbles:true}))`);
    await sleep(150);
    const gen2 = await ev(`__txt('#gen-output')`);
    eq('调整长度后重新生成为 24 位', gen2.length, 24);
    await ev(`__click('#gen-regen')`);
    await sleep(150);
    ok('重新生成得到不同密码', (await ev(`__txt('#gen-output')`)) !== gen2, '');
    await ev(`__click('[data-close="generator"]')`);
    await sleep(80);
    eq('关闭生成器弹窗', await ev(`__hid('#generator-modal')`), true);

    // ======================= 9. 生成并填入条目密码 =======================
    process.stdout.write('\n[生成并填入条目密码]\n');
    await ev(`__click('#btn-new')`);
    await sleep(100);
    await ev(`__click('[data-action="gen-fill"]')`);
    await sleep(150);
    const filled = await ev(`__val('#entry-password')`);
    ok('点击「生成」后密码框被填入 16 位密码', filled && filled.length === 16, `length=${filled && filled.length}`);
    eq('填入后密码框切换为明文显示', await ev(`__q('#entry-password').type`), 'text');
    await ev(`__click('[data-close="entry"]')`);
    await sleep(80);
    eq('取消编辑后弹窗关闭', await ev(`__hid('#entry-modal')`), true);

    // ======================= 10. TOTP 动态验证码显示 =======================
    process.stdout.write('\n[TOTP 动态验证码]\n');
    await ev(`__click('#btn-new')`);
    await sleep(100);
    await ev(`
      __setval('#entry-title','TOTP 测试');
      __setval('#entry-totp','otpauth://totp/X?secret=${SECRET_B32}&digits=6&period=30');
      __submit('#entry-form');
    `);
    await sleep(400);
    await ev(`__click('#entry-list li:last-child')`);
    await sleep(300);
    eq('含 TOTP 的条目显示验证码区域', await ev(`__hid('#detail-totp')`), false);
    const code = await ev(`__txt('#detail-totp-code')`);
    ok('验证码为 6 位数字', /^\d{6}$/.test(code), `code=${code}`);
    ok('显示剩余秒数', /^\d+s$/.test(await ev(`__txt('#detail-totp-count')`)), await ev(`__txt('#detail-totp-count')`));

    // ======================= 11. 删除条目 =======================
    process.stdout.write('\n[删除条目]\n');
    const beforeDel = await ev(`__cnt('#entry-list li')`);
    await ev(`__click('#detail-delete')`);
    await sleep(300);
    eq('删除后条目数减一', await ev(`__cnt('#entry-list li')`), beforeDel - 1);
    ok('删除前弹出确认框', (await ev(`window.__confirms.length`)) > 0, '');

    // ======================= 12. 设置：自动锁定 =======================
    process.stdout.write('\n[设置]\n');
    await ev(`__click('#btn-settings')`);
    await sleep(150);
    eq('点击「设置」弹出设置弹窗', await ev(`__hid('#settings-modal')`), false);
    await ev(`__setval('#auto-lock-select','15'); __q('#auto-lock-select').dispatchEvent(new Event('change',{bubbles:true}))`);
    await sleep(150);
    eq('自动锁定设置持久化到主进程', await ev(`(async()=> (await window.api.getAutoLock()).autoLockMinutes)()`), 15);

    // ======================= 13. 导出 / 导入（UI 入口） =======================
    process.stdout.write('\n[导出 / 导入（UI 入口）]\n');
    const csvPath = path.join(filesDir, 'export.csv');
    stubIO.savePath = csvPath;
    await ev(`window.__alerts.length = 0; __click('#btn-export-csv')`);
    await sleep(400);
    ok('UI 点击导出 CSV 生成文件', fs.existsSync(csvPath), csvPath);
    if (fs.existsSync(csvPath)) {
      const raw = fs.readFileSync(csvPath, 'utf8');
      ok('导出内容含表头', raw.slice(1).startsWith('title,username,password,url,notes,totp'), '');
    }
    ok('导出成功后有提示（alert）', (await ev(`window.__alerts.length`)) > 0, '');

    const beforeImport = await ev(`__cnt('#entry-list li')`);
    stubIO.openPaths = [csvPath];
    await ev(`window.__alerts.length = 0; __click('#btn-import-csv')`);
    await sleep(500);
    ok('UI 点击导入后条目数增加', (await ev(`__cnt('#entry-list li')`)) > beforeImport, `before=${beforeImport}`);
    ok('导入成功后有提示（alert）', (await ev(`window.__alerts.length`)) > 0, '');

    // ======================= 14. 加密备份（UI 入口） =======================
    process.stdout.write('\n[加密备份（UI 入口）]\n');
    const bkPath = path.join(filesDir, 'backup.pmbackup');
    stubIO.savePath = bkPath;
    await ev(`__click('#btn-backup')`);
    await sleep(150);
    eq('点击「导出加密备份」弹出主密码确认框', await ev(`__hid('#backup-modal')`), false);
    await ev(`__setval('#backup-password','backup-pass'); __click('#backup-confirm')`);
    await sleep(500);
    ok('生成加密备份文件', fs.existsSync(bkPath), bkPath);
    if (fs.existsSync(bkPath)) {
      const obj = JSON.parse(fs.readFileSync(bkPath, 'utf8'));
      eq('备份格式为 PM_BACKUP', obj.format, 'PM_BACKUP');
      ok('备份不含明文密码', !fs.readFileSync(bkPath, 'utf8').includes('p@ss'), '');
    }
    eq('导出完成后确认框关闭', await ev(`__hid('#backup-modal')`), true);

    await ev(`__click('[data-close="settings"]')`);
    await sleep(80);
    eq('关闭设置弹窗', await ev(`__hid('#settings-modal')`), true);

    // ======================= 14b. 生成器字符集开关 =======================
    process.stdout.write('\n[生成器字符集开关]\n');
    await ev(`__click('#btn-generator')`);
    await sleep(150);
    await ev(`
      (() => {
        const set = (id, v) => { const el = __q(id); el.checked = v; el.dispatchEvent(new Event('change',{bubbles:true})); };
        set('#gen-upper', false); set('#gen-digits', false); set('#gen-symbols', false); set('#gen-lower', true);
      })();
    `);
    await sleep(200);
    const lowerOnly = await ev(`__txt('#gen-output')`);
    ok('仅保留小写时输出全为小写字母', /^[a-z]+$/.test(lowerOnly), lowerOnly);
    await ev(`
      (() => {
        const set = (id, v) => { const el = __q(id); el.checked = v; el.dispatchEvent(new Event('change',{bubbles:true})); };
        set('#gen-upper', true); set('#gen-digits', true); set('#gen-symbols', true);
      })();
    `);
    await sleep(150);
    await ev(`__click('[data-close="generator"]')`);
    await sleep(80);

    // ======================= 14c. 畸形加密备份应给出错误而非卡死 =======================
    process.stdout.write('\n[畸形加密备份的容错]\n');
    const badBk = path.join(filesDir, 'malformed.pmbackup');
    fs.writeFileSync(badBk, JSON.stringify({ format: 'PM_BACKUP', version: 1 }), 'utf8');
    stubIO.openPaths = [badBk];
    await ev(`__click('#btn-restore')`);
    await sleep(150);
    eq('点击「恢复加密备份」弹出主密码确认框', await ev(`__hid('#backup-modal')`), false);
    await ev(`window.__alerts.length = 0; __setval('#backup-password','whatever'); __click('#backup-confirm')`);
    await sleep(500);
    const bkErr = await ev(`__txt('#backup-error')`);
    ok('畸形备份给出可读错误提示', bkErr && bkErr.length > 0, `err=${JSON.stringify(bkErr)}`);
    ok('畸形备份不是静默失败（无成功 alert）', (await ev(`window.__alerts.length`)) === 0, '');
    eq('畸形备份后弹窗保持打开以便重试', await ev(`__hid('#backup-modal')`), false);
    await ev(`__click('[data-close="backup"]')`);
    await sleep(80);
    eq('可正常关闭备份确认框', await ev(`__hid('#backup-modal')`), true);

    // ======================= 14d. TOTP 非法参数容错 =======================
    process.stdout.write('\n[TOTP 非法参数容错]\n');
    await ev(`__click('#btn-new')`);
    await sleep(100);
    await ev(`
      __setval('#entry-title','TOTP 异常参数');
      __setval('#entry-totp','otpauth://totp/X?secret=${SECRET_B32}&digits=abc&period=abc');
      __submit('#entry-form');
    `);
    await sleep(400);
    await ev(`__click('#entry-list li:last-child')`);
    await sleep(400);
    eq('非法 TOTP 参数条目仍显示验证码区域', await ev(`__hid('#detail-totp')`), false);
    const badCode = await ev(`__txt('#detail-totp-code')`);
    ok('非法参数回退默认后仍输出 6 位数字', /^\d{6}$/.test(badCode), `code=${badCode}`);

    // ======================= 15. 锁定 / 解锁 =======================
    process.stdout.write('\n[锁定与解锁]\n');
    await ev(`__click('#btn-lock')`);
    await sleep(500);
    s = await snap();
    check('锁定后回到认证视图', s.mainHidden === true && s.mainDisplay === 'none' && s.authDisplay !== 'none',
      `mainHidden=${s.mainHidden} mainDisplay=${s.mainDisplay}`);
    eq('锁定后标题为「解锁保险库」', s.title, '解锁保险库');
    eq('解锁模式隐藏确认密码框', s.confirmHidden, true);
    eq('解锁模式按钮为「解锁」', s.submitText, '解锁');

    await ev(`__setval('#auth-password','wrong-password'); __submit('#auth-form');`);
    await sleep(400);
    s = await snap();
    ok('错误主密码给出错误提示', /错误/.test(s.err || ''), `err=${s.err}`);
    check('错误主密码不解锁', s.mainHidden === true, `mainHidden=${s.mainHidden}`);

    await ev(`__setval('#auth-password','${PASSWORD}'); __submit('#auth-form');`);
    await sleep(700);
    s = await snap();
    check('正确主密码解锁成功', s.mainHidden === false && s.mainDisplay !== 'none', `mainHidden=${s.mainHidden}`);
    ok('解锁后条目数据仍在', (await ev(`__cnt('#entry-list li')`)) > 0, '');

    // ======================= 16. 全程无渲染层报错 =======================
    process.stdout.write('\n[渲染层错误检查]\n');
    check('渲染层全程无未捕获错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  } catch (err) {
    check('测试执行未抛出异常', false, String((err && err.stack) || err));
  }

  // ---------------------------------------------------------------------------
  const total = results.length;
  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`E2E 结果：${total - failed}/${total} 通过，${failed} 失败\n`);
  process.stdout.write(`========================================\n`);

  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(filesDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  app.exit(failed === 0 ? 0 : 1);
});
