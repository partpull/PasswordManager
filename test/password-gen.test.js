'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { useHarness } = require('../test-support/harness');

test('密码生成器', async (t) => {
  const h = useHarness(t);

  await t.test('默认长度 16 且四类字符均出现', async () => {
    const r = await h.invoke('gen:password');
    assert.strictEqual(r.password.length, 16);
    assert.match(r.password, /[A-Z]/);
    assert.match(r.password, /[a-z]/);
    assert.match(r.password, /[0-9]/);
    assert.match(r.password, /[!@#$%^&*()\-_=+\[\]{};:,.?]/);
  });

  await t.test('指定长度生效', async () => {
    assert.strictEqual((await h.invoke('gen:password', 32, {})).password.length, 32);
    assert.strictEqual((await h.invoke('gen:password', 8, {})).password.length, 8);
    assert.strictEqual((await h.invoke('gen:password', 128, {})).password.length, 128);
  });

  await t.test('非法长度回退为默认 16', async () => {
    assert.strictEqual((await h.invoke('gen:password', 3, {})).password.length, 16);
    assert.strictEqual((await h.invoke('gen:password', 129, {})).password.length, 16);
    assert.strictEqual((await h.invoke('gen:password', 'x', {})).password.length, 16);
  });

  await t.test('仅选择小写与数字时字符集受限', async () => {
    const r = await h.invoke('gen:password', 24, { upper: false, lower: true, digits: true, symbols: false });
    assert.match(r.password, /^[a-z0-9]+$/);
  });

  await t.test('全部类别取消时回退为全字符集', async () => {
    const r = await h.invoke('gen:password', 32, { upper: false, lower: false, digits: false, symbols: false });
    assert.match(r.password, /[A-Z]/);
    assert.match(r.password, /[a-z]/);
    assert.match(r.password, /[0-9]/);
  });

  await t.test('每个启用类别至少出现一次', async () => {
    for (let i = 0; i < 15; i++) {
      const r = await h.invoke('gen:password', 8, {});
      assert.match(r.password, /[A-Z]/);
      assert.match(r.password, /[a-z]/);
      assert.match(r.password, /[0-9]/);
      assert.match(r.password, /[!@#$%^&*()\-_=+\[\]{};:,.?]/);
    }
  });

  await t.test('排除易混淆字符 0 1 O I l', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await h.invoke('gen:password', 128, {});
      assert.doesNotMatch(r.password, /[01OIl]/, '不应包含易混淆字符');
    }
  });

  await t.test('熵值随长度增长', async () => {
    const a = await h.invoke('gen:password', 16, {});
    const b = await h.invoke('gen:password', 32, {});
    assert.ok(b.bits > a.bits);
    assert.ok(a.bits > 0);
  });

  await t.test('随机性：两次结果不同', async () => {
    const a = await h.invoke('gen:password', 32, {});
    const b = await h.invoke('gen:password', 32, {});
    assert.notStrictEqual(a.password, b.password);
  });
});
