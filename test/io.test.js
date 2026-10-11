'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useHarness, assertThrows } = require('../test-support/harness');

test('导入导出（CSV / JSON）', async (t) => {
  const h = useHarness(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-io-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  await t.test('未解锁时导出返回错误', async () => {
    const hL = useHarness(t);
    const r = await hL.invoke('io:export', 'csv');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /未解锁/);
  });

  await h.invoke('vault:init', 'master-1234');
  await h.invoke('entry:add', {
    title: 'GitHub', username: 'me@a.com', password: 'p@ss,1',
    url: 'https://github.com', notes: 'a "quote"\nnewline', totp: ''
  });
  await h.invoke('entry:add', { title: 'Gmail', username: 'u2', password: 'pw2' });

  await t.test('取消保存返回 canceled', async () => {
    h.setSavePath(null);
    const r = await h.invoke('io:export', 'csv');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.canceled, true);
  });

  await t.test('导出 CSV：带 BOM、含表头、正确转义逗号/引号/换行', async () => {
    const csvPath = path.join(tmp, 'out.csv');
    h.setSavePath(csvPath);
    const r = await h.invoke('io:export', 'csv');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    const raw = fs.readFileSync(csvPath, 'utf8');
    assert.ok(raw.startsWith('\ufeff'), '应带 UTF-8 BOM');
    const body = raw.slice(1);
    assert.ok(body.startsWith('title,username,password,url,notes,totp'));
    assert.ok(body.includes('"p@ss,1"'), '含逗号的值应被引号包裹');
    assert.ok(body.includes('"a ""quote""\nnewline"'), '引号应双写、换行应保留');
  });

  await t.test('导入 CSV 到新保险库，数据完整一致', async () => {
    const csvPath = path.join(tmp, 'out.csv');
    const h2 = useHarness(t);
    await h2.invoke('vault:init', 'other-1234');
    h2.setOpenPaths([csvPath]);
    const r = await h2.invoke('io:import', 'csv');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.added, 2);
    const list = await h2.invoke('entry:list');
    assert.strictEqual(list.length, 2);
    const gh = list.find((e) => e.title === 'GitHub');
    assert.ok(gh, '应导入 GitHub 条目');
    assert.strictEqual(gh.password, 'p@ss,1');
    assert.strictEqual(gh.notes, 'a "quote"\nnewline');
    assert.strictEqual(gh.username, 'me@a.com');
  });

  await t.test('导出并导入 JSON', async () => {
    const jsonPath = path.join(tmp, 'out.json');
    h.setSavePath(jsonPath);
    const e = await h.invoke('io:export', 'json');
    assert.strictEqual(e.ok, true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 2);

    const h3 = useHarness(t);
    await h3.invoke('vault:init', 'third-1234');
    h3.setOpenPaths([jsonPath]);
    const r = await h3.invoke('io:import', 'json');
    assert.strictEqual(r.added, 2);
    assert.strictEqual((await h3.invoke('entry:list')).length, 2);
  });

  await t.test('导入损坏的 JSON 返回错误', async () => {
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{ not valid json', 'utf8');
    h.setOpenPaths([bad]);
    const r = await h.invoke('io:import', 'json');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t.test('导入 CSV 会跳过空行', async () => {
    const csv = path.join(tmp, 'skip.csv');
    fs.writeFileSync(csv, 'title,username,password,url,notes,totp\r\nA,u,p,,,\r\n,,,,\r\n', 'utf8');
    const h4 = useHarness(t);
    await h4.invoke('vault:init', 'skip-1234');
    h4.setOpenPaths([csv]);
    const r = await h4.invoke('io:import', 'csv');
    assert.strictEqual(r.added, 1);
  });

  await t.test('未选择文件返回 canceled', async () => {
    h.setOpenPaths(null);
    const r = await h.invoke('io:import', 'csv');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.canceled, true);
  });
});
