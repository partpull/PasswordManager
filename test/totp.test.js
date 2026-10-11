'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { useHarness } = require('../test-support/harness');

// RFC 6238 附录 B 的三种种子（不同算法使用不同长度的种子）
//   SHA1   : 20 字节 "12345678901234567890"
//   SHA256 : 32 字节 "12345678901234567890123456789012"
//   SHA512 : 64 字节 "1234567890123456789012345678901234567890123456789012345678901234"
const SEED_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SEED_SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SEED_SHA512 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

test('TOTP 动态验证码', async (t) => {
  const h = useHarness(t);
  await h.invoke('vault:init', 'master-1234');
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  await t.test('未配置 TOTP 的条目返回错误', async () => {
    const { entry } = await h.invoke('entry:add', { title: 'plain' });
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t.test('条目不存在时返回错误', async () => {
    const r = await h.invoke('entry:totp', 'no-such-id');
    assert.strictEqual(r.ok, false);
  });

  await t.test('RFC 6238 向量：SHA1 / 8 位 / T=59s → 94287082', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'rfc-sha1',
      totp: `otpauth://totp/Test?secret=${SEED_SHA1}&digits=8&period=30&algorithm=SHA1`
    });
    Date.now = () => 59 * 1000;
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, '94287082');
    assert.strictEqual(r.remaining, 1);
  });

  await t.test('RFC 6238 向量：SHA256 / 8 位 / T=59s → 46119246', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'rfc-sha256',
      totp: `otpauth://totp/Test?secret=${SEED_SHA256}&digits=8&algorithm=SHA256`
    });
    Date.now = () => 59 * 1000;
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.code, '46119246');
  });

  await t.test('RFC 6238 向量：SHA512 / 8 位 / T=59s → 90693936', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'rfc-sha512',
      totp: `otpauth://totp/Test?secret=${SEED_SHA512}&digits=8&algorithm=SHA512`
    });
    Date.now = () => 59 * 1000;
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.code, '90693936');
  });

  await t.test('纯 base32 密钥：默认 6 位、30 秒周期', async () => {
    const { entry } = await h.invoke('entry:add', { title: 'plain32', totp: SEED_SHA1 });
    Date.now = () => 59 * 1000;
    const r = await h.invoke('entry:totp', entry.id);
    assert.match(r.code, /^\d{6}$/);
    assert.strictEqual(r.remaining, 1);
  });

  await t.test('remaining 始终落在 1..period，code 为纯数字并补齐位数', async () => {
    const { entry } = await h.invoke('entry:add', { title: 'range', totp: SEED_SHA1 });
    for (const sec of [0, 1, 14, 29, 30, 31, 59, 60, 61, 12345]) {
      Date.now = () => sec * 1000;
      const r = await h.invoke('entry:totp', entry.id);
      assert.ok(r.remaining >= 1 && r.remaining <= 30, `remaining=${r.remaining} @${sec}s`);
      assert.match(r.code, /^\d{6}$/);
    }
  });

  await t.test('大小写与空格混入的 base32 仍可解析', async () => {
    const { entry } = await h.invoke('entry:add', {
      title: 'messy',
      totp: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq'
    });
    Date.now = () => 59 * 1000;
    const r = await h.invoke('entry:totp', entry.id);
    assert.strictEqual(r.code.length, 6);
  });
});
