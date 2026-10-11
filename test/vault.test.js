'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useHarness } = require('../test-support/harness');

test('保险库生命周期与加密存储', async (t) => {
  const h = useHarness(t);

  await t.test('注册了全部预期的 IPC 通道', () => {
    const expected = [
      'vault:getStatus', 'vault:init', 'vault:unlock', 'vault:lock',
      'entry:list', 'entry:add', 'entry:update', 'entry:delete', 'entry:totp',
      'session:activity', 'session:getAutoLock', 'session:setAutoLock',
      'io:export', 'io:import', 'io:exportEncrypted', 'io:importEncrypted',
      'gen:password', 'clipboard:copy'
    ];
    const channels = h.channels();
    for (const c of expected) assert.ok(channels.includes(c), '缺少通道: ' + c);
  });

  await t.test('初始状态：未初始化、未解锁、条目数为 0', async () => {
    const s = await h.invoke('vault:getStatus');
    assert.strictEqual(s.initialized, false);
    assert.strictEqual(s.unlocked, false);
    assert.strictEqual(s.entryCount, 0);
  });

  await t.test('主密码过短被拒绝，且不落盘', async () => {
    const r = await h.invoke('vault:init', 'abc');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /4/);
    assert.strictEqual(fs.existsSync(h.vaultFile), false);
  });

  await t.test('非字符串主密码被拒绝', async () => {
    const r = await h.invoke('vault:init', 12345);
    assert.strictEqual(r.ok, false);
  });

  await t.test('创建保险库成功并落盘', async () => {
    const r = await h.invoke('vault:init', 'master-1234');
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(fs.existsSync(h.vaultFile), true);
    const s = await h.invoke('vault:getStatus');
    assert.strictEqual(s.initialized, true);
    assert.strictEqual(s.unlocked, true);
  });

  await t.test('重复创建被拒绝', async () => {
    const r = await h.invoke('vault:init', 'another-1234');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /已存在/);
  });

  await t.test('落盘为 PM_VAULT 加密格式，且不含明文主密码', async () => {
    const raw = fs.readFileSync(h.vaultFile, 'utf8');
    const obj = JSON.parse(raw);
    assert.strictEqual(obj.format, 'PM_VAULT');
    assert.strictEqual(obj.version, 1);
    assert.strictEqual(obj.kdf.algo, 'scrypt');
    assert.strictEqual(obj.kdf.N, 16384);
    assert.ok(obj.iv && obj.tag && obj.data);
    assert.ok(!raw.includes('master-1234'), '文件中不应出现明文主密码');
  });

  await t.test('锁定后为未解锁状态', async () => {
    await h.invoke('vault:lock');
    const s = await h.invoke('vault:getStatus');
    assert.strictEqual(s.unlocked, false);
    assert.strictEqual(s.initialized, true);
  });

  await t.test('错误主密码解锁失败', async () => {
    const r = await h.invoke('vault:unlock', 'wrong-pass');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
    const s = await h.invoke('vault:getStatus');
    assert.strictEqual(s.unlocked, false);
  });

  await t.test('正确主密码解锁成功', async () => {
    const r = await h.invoke('vault:unlock', 'master-1234');
    assert.strictEqual(r.ok, true);
    assert.ok(Array.isArray(r.entries));
    const s = await h.invoke('vault:getStatus');
    assert.strictEqual(s.unlocked, true);
  });

  await t.test('篡改密文后解密失败（GCM 完整性校验）', async () => {
    const obj = JSON.parse(fs.readFileSync(h.vaultFile, 'utf8'));
    const buf = Buffer.from(obj.data, 'base64');
    buf[0] ^= 0xff; // 破坏一个字节
    obj.data = buf.toString('base64');
    fs.writeFileSync(h.vaultFile, JSON.stringify(obj), 'utf8');
    await h.invoke('vault:lock');
    const r = await h.invoke('vault:unlock', 'master-1234');
    assert.strictEqual(r.ok, false);
  });
});
