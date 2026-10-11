'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { useHarness, assertThrows } = require('../test-support/harness');

test('条目增删改查与持久化', async (t) => {
  const h = useHarness(t);
  await h.invoke('vault:init', 'master-1234');
  let created;

  await t.test('未解锁时禁止访问条目（返回结构化错误）', async () => {
    const hL = useHarness(t);
    const r1 = await hL.invoke('entry:list');
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /未解锁/);
    const r2 = await hL.invoke('entry:add', { title: 'x' });
    assert.strictEqual(r2.ok, false);
    const r3 = await hL.invoke('entry:delete', 'x');
    assert.strictEqual(r3.ok, false);
  });

  await t.test('新增条目返回完整字段', async () => {
    const r = await h.invoke('entry:add', {
      title: 'GitHub', username: 'me@a.com', password: 'p@ss',
      url: 'https://github.com', notes: 'note', totp: 'SECRET'
    });
    assert.strictEqual(r.ok, true);
    created = r.entry;
    assert.ok(created.id);
    assert.strictEqual(created.title, 'GitHub');
    assert.strictEqual(created.username, 'me@a.com');
    assert.strictEqual(created.password, 'p@ss');
    assert.strictEqual(created.url, 'https://github.com');
    assert.strictEqual(created.notes, 'note');
    assert.strictEqual(created.totp, 'SECRET');
    assert.ok(created.createdAt > 0 && created.updatedAt > 0);
  });

  await t.test('缺省字段填充为空字符串', async () => {
    const r = await h.invoke('entry:add', {});
    assert.strictEqual(r.entry.title, '');
    assert.strictEqual(r.entry.password, '');
    assert.strictEqual(r.entry.totp, '');
  });

  await t.test('列表包含新增条目', async () => {
    const list = await h.invoke('entry:list');
    assert.strictEqual(list.length, 2);
    assert.ok(list.find((e) => e.id === created.id));
  });

  await t.test('状态中的条目数正确', async () => {
    assert.strictEqual((await h.invoke('vault:getStatus')).entryCount, 2);
  });

  await t.test('更新条目字段', async () => {
    const r = await h.invoke('entry:update', created.id, { title: 'GitHub 2', password: 'pw2' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.entry.title, 'GitHub 2');
    assert.strictEqual(r.entry.password, 'pw2');
    assert.strictEqual(r.entry.username, 'me@a.com'); // 未提供字段保持不变
  });

  await t.test('更新不存在的条目返回错误', async () => {
    const r = await h.invoke('entry:update', 'no-such-id', { title: 'x' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t.test('更新时忽略非白名单字段（id/createdAt 不可篡改）', async () => {
    const before = created.createdAt;
    const r = await h.invoke('entry:update', created.id, { id: 'hacked', createdAt: 1, title: 'ok' });
    assert.strictEqual(r.entry.id, created.id);
    assert.strictEqual(r.entry.createdAt, before);
  });

  await t.test('持久化：锁定后重新解锁数据仍在', async () => {
    await h.invoke('vault:lock');
    const r = await h.invoke('vault:unlock', 'master-1234');
    assert.strictEqual(r.ok, true);
    const list = await h.invoke('entry:list');
    assert.strictEqual(list.length, 2);
    assert.ok(list.find((e) => e.id === created.id && e.title === 'ok'));
  });

  await t.test('删除条目后列表与计数同步', async () => {
    const r = await h.invoke('entry:delete', created.id);
    assert.strictEqual(r.ok, true);
    const list = await h.invoke('entry:list');
    assert.strictEqual(list.length, 1);
    assert.ok(!list.find((e) => e.id === created.id));
    assert.strictEqual((await h.invoke('vault:getStatus')).entryCount, 1);
  });
});
