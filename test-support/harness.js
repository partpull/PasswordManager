'use strict';
// 单元测试脚手架：在主进程之外的纯 Node 环境中加载 main.js。
// 通过向 require 缓存注入 electron 的模拟实现，直接拿到 main.js 注册的
// ipcMain 处理器进行调用，从而在无需启动窗口的情况下测试全部业务逻辑。
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAIN_PATH = require.resolve('../main.js');
const ELECTRON_PATH = require.resolve('electron');

function createHarness() {
  // 每个 harness 使用独立的临时 userData 目录，保证测试之间互不干扰
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  const handlers = new Map();
  const clipboardState = { text: '' };
  const sent = [];
  const dialogState = { savePath: null, openPaths: null };

  const app = {
    getPath: () => userData,
    whenReady: () => new Promise(() => {}), // 永不 resolve，跳过窗口创建
    on: () => {},
    quit: () => {}
  };

  class BrowserWindow {
    constructor() {
      this.webContents = { send: (...args) => sent.push(args) };
    }
    loadFile() {}
    static getAllWindows() {
      return [];
    }
    static getFocusedWindow() {
      return null;
    }
  }

  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  const clipboard = {
    writeText: (t) => { clipboardState.text = t; },
    readText: () => clipboardState.text,
    clear: () => { clipboardState.text = ''; }
  };

  const dialog = {
    showSaveDialog: async () =>
      dialogState.savePath
        ? { canceled: false, filePath: dialogState.savePath }
        : { canceled: true },
    showOpenDialog: async () =>
      dialogState.openPaths
        ? { canceled: false, filePaths: dialogState.openPaths }
        : { canceled: true }
  };

  require.cache[ELECTRON_PATH] = {
    id: ELECTRON_PATH,
    filename: ELECTRON_PATH,
    loaded: true,
    exports: { app, BrowserWindow, ipcMain, clipboard, dialog },
    children: [],
    paths: []
  };
  // 清除 main.js 缓存，使每次 harness 都重新注册处理器并重置模块内部状态
  delete require.cache[MAIN_PATH];
  require(MAIN_PATH);

  const invoke = async (channel, ...args) => {
    if (!handlers.has(channel)) throw new Error('未注册的 IPC 通道: ' + channel);
    return await handlers.get(channel)(null, ...args);
  };

  return {
    userData,
    vaultFile: path.join(userData, 'vault.pm'),
    invoke,
    sent,
    clipboardState,
    channels: () => Array.from(handlers.keys()),
    setSavePath: (p) => { dialogState.savePath = p; },
    setOpenPaths: (p) => { dialogState.openPaths = p; },
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true })
  };
}

// 创建 harness 并自动注册清理：关闭自动锁定计时器、锁定保险库、删除临时目录。
// 关闭自动锁定是为了避免挂起的 setTimeout 阻止测试进程退出。
function useHarness(t) {
  const h = createHarness();
  t.after(async () => {
    try { await h.invoke('session:setAutoLock', 0); } catch (_) { /* ignore */ }
    try { await h.invoke('vault:lock'); } catch (_) { /* ignore */ }
    h.cleanup();
  });
  return h;
}

async function assertThrows(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

module.exports = { createHarness, useHarness, assertThrows };
