'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { useHarness } = require('../test-support/harness');

test('自动锁定与剪贴板', async (t) => {
  await t.test('默认自动锁定为 5 分钟', async (t2) => {
    const h = useHarness(t2);
    assert.strictEqual((await h.invoke('session:getAutoLock')).autoLockMinutes, 5);
  });

  await t.test('设置并读取自动锁定时间', async (t2) => {
    const h = useHarness(t2);
    assert.strictEqual((await h.invoke('session:setAutoLock', 15)).autoLockMinutes, 15);
    assert.strictEqual((await h.invoke('session:getAutoLock')).autoLockMinutes, 15);
  });

  await t.test('非法值一律视为关闭(0)', async (t2) => {
    const h = useHarness(t2);
    assert.strictEqual((await h.invoke('session:setAutoLock', 'abc')).autoLockMinutes, 0);
    assert.strictEqual((await h.invoke('session:setAutoLock', 0)).autoLockMinutes, 0);
    assert.strictEqual((await h.invoke('session:setAutoLock', -5)).autoLockMinutes, 0);
    assert.strictEqual((await h.invoke('session:setAutoLock', null)).autoLockMinutes, 0);
  });

  await t.test('activity 返回 true', async (t2) => {
    const h = useHarness(t2);
    assert.strictEqual(await h.invoke('session:activity'), true);
  });

  await t.test('空闲超时后自动锁定', async (t2) => {
    const h = useHarness(t2);
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    await h.invoke('vault:init', 'master-1234');
    await h.invoke('session:setAutoLock', 1);
    assert.strictEqual((await h.invoke('vault:getStatus')).unlocked, true);
    t2.mock.timers.tick(60 * 1000);
    assert.strictEqual((await h.invoke('vault:getStatus')).unlocked, false);
  });

  await t.test('活动会重置计时器，不提前锁定', async (t2) => {
    const h = useHarness(t2);
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    await h.invoke('vault:init', 'master-1234');
    await h.invoke('session:setAutoLock', 1);
    t2.mock.timers.tick(50 * 1000);       // 距超时还差 10s
    await h.invoke('session:activity');   // 重置计时
    t2.mock.timers.tick(50 * 1000);       // 距重置仅 50s，不应锁定
    assert.strictEqual((await h.invoke('vault:getStatus')).unlocked, true);
    t2.mock.timers.tick(20 * 1000);       // 累计超过 60s，锁定
    assert.strictEqual((await h.invoke('vault:getStatus')).unlocked, false);
  });

  await t.test('复制到剪贴板并在 30 秒后自动清除', async (t2) => {
    const h = useHarness(t2);
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    assert.strictEqual(await h.invoke('clipboard:copy', 'abc'), true);
    assert.strictEqual(h.clipboardState.text, 'abc');
    t2.mock.timers.tick(30 * 1000);
    assert.strictEqual(h.clipboardState.text, '');
  });

  await t.test('剪贴板内容被其他程序覆盖时不清除', async (t2) => {
    const h = useHarness(t2);
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    await h.invoke('clipboard:copy', 'abc');
    h.clipboardState.text = 'user-copied'; // 模拟用户复制了别的内容
    t2.mock.timers.tick(30 * 1000);
    assert.strictEqual(h.clipboardState.text, 'user-copied');
  });

  await t.test('空值或非字符串不写入剪贴板', async (t2) => {
    const h = useHarness(t2);
    assert.strictEqual(await h.invoke('clipboard:copy', ''), false);
    assert.strictEqual(await h.invoke('clipboard:copy', 123), false);
  });
});
