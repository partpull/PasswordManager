'use strict';
// 健壮性 / 边界 / 异常路径测试。
// 目标：把「看似正常」的代码放到真实输入下，暴露未处理的异常与静默错误。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useHarness, assertThrows } = require('../test-support/harness');

const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('未解锁守卫覆盖所有需要会话的通道', async (t) => {
  const h = useHarness(t);

  for (const [channel, args] of [
    ['entry:list', []],
    ['entry:add', [{ title: 'x' }]],
    ['entry:update', ['id', { title: 'x' }]],
    ['entry:delete', ['id']],
    ['entry:totp', ['id']],
    ['io:export', ['csv']],
    ['io:import', ['csv']],
    ['io:exportEncrypted', ['pw']],
    ['io:importEncrypted', ['pw']]
  ]) {
    await t.test(`${channel} 未解锁时返回结构化错误`, async () => {
      const r = await h.invoke(channel, ...args);
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /未解锁/);
    });
  }
});

test('加密备份：畸形文件应优雅报错而非抛异常', async (t) => {
  const h = useHarness(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rb-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  await h.invoke('vault:init', 'master-1234');

  await t.test('声明为 PM_BACKUP 但缺少 kdf 字段', async () => {
    const bad = path.join(tmp, 'nokdf.pmbackup');
    fs.writeFileSync(bad, JSON.stringify({ format: 'PM_BACKUP', version: 1 }), 'utf8');
    h.setOpenPaths([bad]);
    const r = await h.invoke('io:importEncrypted', 'any-pass');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '应给出可读错误信息');
  });

  await t.test('kdf 缺少 salt', async () => {
    const bad = path.join(tmp, 'nosalt.pmbackup');
    fs.writeFileSync(bad, JSON.stringify({
      format: 'PM_BACKUP', version: 1, kdf: { algo: 'scrypt' }, iv: 'AA==', tag: 'AA==', data: 'AA=='
    }), 'utf8');
    h.setOpenPaths([bad]);
    const r = await h.invoke('io:importEncrypted', 'any-pass');
    assert.strictEqual(r.ok, false);
  });

  await t.test('顶层为 JSON 数组而非对象', async () => {
    const bad = path.join(tmp, 'arr.pmbackup');
    fs.writeFileSync(bad, '[]', 'utf8');
    h.setOpenPaths([bad]);
    const r = await h.invoke('io:importEncrypted', 'any-pass');
    assert.strictEqual(r.ok, false);
  });
});

test('TOTP：otpauth 参数异常时应回退默认而非崩溃', async (t) => {
  const h = useHarness(t);
  await h.invoke('vault:init', 'master-1234');
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => 59 * 1000;

  await t.test('period 为非数字（abc）', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'bad-period',
      totp: `otpauth://totp/X?secret=${SEED}&period=abc`
    });
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, true, '应回退到默认周期并正常出码');
    assert.match(r.code, /^\d{6}$/);
  });

  await t.test('digits 为非数字（abc）', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'bad-digits',
      totp: `otpauth://totp/X?secret=${SEED}&digits=abc`
    });
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, true);
    assert.match(r.code, /^\d{6}$/, `期望 6 位数字，实际 ${r.code}`);
  });

  await t.test('period 为 0 或负数', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'zero-period',
      totp: `otpauth://totp/X?secret=${SEED}&period=0`
    });
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, true);
    assert.match(r.code, /^\d{6}$/);
    assert.ok(r.remaining >= 1);
  });

  await t.test('digits 超出合理范围（20 位）', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'huge-digits',
      totp: `otpauth://totp/X?secret=${SEED}&digits=20`
    });
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, true);
    assert.match(r.code, /^\d{6,8}$/, `位数应被限制，实际长度 ${r.code && r.code.length}`);
  });

  await t.test('secret 为空字符串时返回错误而非崩溃', async () => {
    const { entry } = await h.invoke('entry:add', { title: 'empty-secret', totp: '   ' });
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, false);
  });
});

test('条目更新：非法 patch 不应抛异常', async (t) => {
  const h = useHarness(t);
  await h.invoke('vault:init', 'master-1234');
  const { entry } = await h.invoke('entry:add', { title: 'T', password: 'p' });

  await t.test('patch 为字符串', async () => {
    const r = await h.invoke('entry:update', entry.id, 'not-an-object');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t.test('patch 为 null', async () => {
    const r = await h.invoke('entry:update', entry.id, null);
    assert.strictEqual(r.ok, true, 'null 应视为空补丁，仅更新时间戳');
  });

  await t.test('patch 为数组', async () => {
    const r = await h.invoke('entry:update', entry.id, ['title']);
    assert.strictEqual(r.ok, true);
  });
});

test('导入边界：JSON 形态多样性', async (t) => {
  const h = useHarness(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rb2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  await h.invoke('vault:init', 'master-1234');

  await t.test('空对象 {} 导入 0 条', async () => {
    const p = path.join(tmp, 'empty.json');
    fs.writeFileSync(p, '{}', 'utf8');
    h.setOpenPaths([p]);
    const r = await h.invoke('io:import', 'json');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.added, 0);
  });

  await t.test('{entries:[...]} 包裹形态可导入', async () => {
    const p = path.join(tmp, 'wrap.json');
    fs.writeFileSync(p, JSON.stringify({ entries: [{ title: 'wrapped', password: 'w' }] }), 'utf8');
    h.setOpenPaths([p]);
    const r = await h.invoke('io:import', 'json');
    assert.strictEqual(r.added, 1);
  });

  await t.test('数组中的非对象元素被过滤', async () => {
    const p = path.join(tmp, 'mixed.json');
    fs.writeFileSync(p, JSON.stringify([{ title: 'ok' }, 42, null, 'str']), 'utf8');
    h.setOpenPaths([p]);
    const r = await h.invoke('io:import', 'json');
    assert.strictEqual(r.added, 1);
  });

  await t.test('数值字段被安全转成字符串', async () => {
    const p = path.join(tmp, 'num.json');
    fs.writeFileSync(p, JSON.stringify([{ title: 123, password: 456 }]), 'utf8');
    h.setOpenPaths([p]);
    const r = await h.invoke('io:import', 'json');
    assert.strictEqual(r.added, 1);
    const list = await h.invoke('entry:list');
    const item = list.find((e) => e.title === '123');
    assert.ok(item, 'title 应被转为字符串 "123"');
    assert.strictEqual(item.password, '456');
  });

  await t.test('含中文 / emoji / 特殊字符的往返一致', async () => {
    await h.invoke('entry:add', { title: '🔐 银行', username: '张三', password: 'p@ss,="\n', notes: '多行\n备注' });
    const out = path.join(tmp, 'rt.json');
    h.setSavePath(out);
    await h.invoke('io:export', 'json');
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    const bank = parsed.find((e) => e.title === '🔐 银行');
    assert.ok(bank);
    assert.strictEqual(bank.username, '张三');
    assert.strictEqual(bank.password, 'p@ss,="\n');
    assert.strictEqual(bank.notes, '多行\n备注');
  });
});

test('剪贴板：连续复制只保留最后一次且计时器重置', async (t) => {
  const h = useHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.invoke('clipboard:copy', 'first');
  t.mock.timers.tick(20 * 1000);
  await h.invoke('clipboard:copy', 'second');
  t.mock.timers.tick(20 * 1000); // 距第二次仅 20s
  assert.strictEqual(h.clipboardState.text, 'second', '不应因第一次的计时器而提前清空');
  t.mock.timers.tick(10 * 1000); // 距第二次满 30s
  assert.strictEqual(h.clipboardState.text, '');
});

test('保险库文件损坏时解锁优雅报错', async (t) => {
  const h = useHarness(t);
  await h.invoke('vault:init', 'master-1234');
  await h.invoke('vault:lock');
  fs.writeFileSync(h.vaultFile, '{ this is not valid json', 'utf8');
  const r = await h.invoke('vault:unlock', 'master-1234');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('CSV：列顺序打乱与多余列仍按表头名映射', async (t) => {
  const h = useHarness(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-csv-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  await h.invoke('vault:init', 'master-1234');

  await t.test('列顺序打乱', async () => {
    const p = path.join(tmp, 'reorder.csv');
    fs.writeFileSync(p, 'password,title,username,url,notes,totp\r\nsecret,Bank,alice,,,\r\n', 'utf8');
    h.setOpenPaths([p]);
    const r = await h.invoke('io:import', 'csv');
    assert.strictEqual(r.added, 1);
    const item = (await h.invoke('entry:list')).find((e) => e.title === 'Bank');
    assert.ok(item);
    assert.strictEqual(item.password, 'secret');
    assert.strictEqual(item.username, 'alice');
  });

  await t.test('含未知多余列不报错', async () => {
    const p = path.join(tmp, 'extra.csv');
    fs.writeFileSync(p, 'title,username,password,url,notes,totp,unknown\r\nX,u,p,,,,\r\n', 'utf8');
    h.setOpenPaths([p]);
    const r = await h.invoke('io:import', 'csv');
    assert.strictEqual(r.added, 1);
  });
});

test('加密备份导入为追加合并（同库）', async (t) => {
  const h = useHarness(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-merge-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  await h.invoke('vault:init', 'master-1234');
  await h.invoke('entry:add', { title: 'A', password: 'pa' });
  const bk = path.join(tmp, 'b.pmbackup');
  h.setSavePath(bk);
  await h.invoke('io:exportEncrypted', 'bk-pass');

  h.setOpenPaths([bk]);
  const r = await h.invoke('io:importEncrypted', 'bk-pass');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 1);
  const list = await h.invoke('entry:list');
  assert.strictEqual(list.length, 2, '应追加而非覆盖');
  assert.strictEqual(list.filter((e) => e.title === 'A').length, 2);
});

test('默认自动锁定 5 分钟真实生效', async (t) => {
  const h = useHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.invoke('vault:init', 'master-1234');
  assert.strictEqual((await h.invoke('session:getAutoLock')).autoLockMinutes, 5);
  t.mock.timers.tick(5 * 60 * 1000 - 1);
  assert.strictEqual((await h.invoke('vault:getStatus')).unlocked, true, '未到 5 分钟不应锁定');
  t.mock.timers.tick(1);
  assert.strictEqual((await h.invoke('vault:getStatus')).unlocked, false, '满 5 分钟应锁定');
});

test('setAutoLock 接受数字字符串', async (t) => {
  const h = useHarness(t);
  assert.strictEqual((await h.invoke('session:setAutoLock', '15')).autoLockMinutes, 15);
});

