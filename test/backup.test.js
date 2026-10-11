'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useHarness, assertThrows } = require('../test-support/harness');

test('加密备份（.pmbackup）', async (t) => {
  const h = useHarness(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bkPath = path.join(tmp, 'backup.pmbackup');

  await t.test('未解锁时导出返回错误', async () => {
    const hL = useHarness(t);
    const r = await hL.invoke('io:exportEncrypted', 'pw');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /未解锁/);
  });

  await h.invoke('vault:init', 'master-1234');
  await h.invoke('entry:add', { title: 'Bank', username: 'u', password: 'secret-pw' });

  await t.test('空主密码被拒绝', async () => {
    const r = await h.invoke('io:exportEncrypted', '');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t.test('取消保存返回 canceled', async () => {
    h.setSavePath(null);
    const r = await h.invoke('io:exportEncrypted', 'backup-pass');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.canceled, true);
  });

  await t.test('导出加密备份：PM_BACKUP 格式且不含明文', async () => {
    h.setSavePath(bkPath);
    const r = await h.invoke('io:exportEncrypted', 'backup-pass');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 1);
    const raw = fs.readFileSync(bkPath, 'utf8');
    const obj = JSON.parse(raw);
    assert.strictEqual(obj.format, 'PM_BACKUP');
    assert.strictEqual(obj.version, 1);
    assert.strictEqual(obj.kdf.algo, 'scrypt');
    assert.ok(!raw.includes('secret-pw'), '不应包含明文条目密码');
    assert.ok(!raw.includes('backup-pass'), '不应包含明文备份主密码');
  });

  await t.test('错误主密码恢复失败且不写入任何条目', async () => {
    const h2 = useHarness(t);
    await h2.invoke('vault:init', 'other-1234');
    h2.setOpenPaths([bkPath]);
    const r = await h2.invoke('io:importEncrypted', 'wrong-pass');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /错误/);
    assert.strictEqual((await h2.invoke('entry:list')).length, 0);
  });

  await t.test('跨保险库用正确主密码恢复成功', async () => {
    const h3 = useHarness(t);
    await h3.invoke('vault:init', 'another-1234');
    h3.setOpenPaths([bkPath]);
    const r = await h3.invoke('io:importEncrypted', 'backup-pass');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.added, 1);
    const list = await h3.invoke('entry:list');
    assert.strictEqual(list[0].password, 'secret-pw');
    assert.strictEqual(list[0].title, 'Bank');
  });

  await t.test('非备份文件被拒绝', async () => {
    const bad = path.join(tmp, 'bad.pmbackup');
    fs.writeFileSync(bad, JSON.stringify({ format: 'OTHER' }), 'utf8');
    h.setOpenPaths([bad]);
    const r = await h.invoke('io:importEncrypted', 'backup-pass');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t.test('损坏的备份文件被拒绝', async () => {
    const bad = path.join(tmp, 'corrupt.pmbackup');
    fs.writeFileSync(bad, '{ broken', 'utf8');
    h.setOpenPaths([bad]);
    const r = await h.invoke('io:importEncrypted', 'backup-pass');
    assert.strictEqual(r.ok, false);
  });

  await t.test('未选择文件返回 canceled', async () => {
    h.setOpenPaths(null);
    const r = await h.invoke('io:importEncrypted', 'backup-pass');
    assert.strictEqual(r.canceled, true);
  });
});
