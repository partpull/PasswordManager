const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 密码生成器（字符集已排除易混淆字符：0/O/o、1/l/I/i）
// ---------------------------------------------------------------------------
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';

function generatePassword(length, opts = {}) {
  const n = Number.isInteger(length) && length >= 4 && length <= 128 ? length : 16;
  const sets = [];
  if (opts.upper !== false) sets.push(UPPER);
  if (opts.lower !== false) sets.push(LOWER);
  if (opts.digits !== false) sets.push(DIGITS);
  if (opts.symbols !== false) sets.push(SYMBOLS);
  if (sets.length === 0) sets.push(UPPER, LOWER, DIGITS, SYMBOLS);
  const charset = sets.join('');

  const chars = sets.map((set) => set[crypto.randomInt(set.length)]);
  while (chars.length < n) {
    chars.push(charset[crypto.randomInt(charset.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return {
    password: chars.join(''),
    bits: Math.round(n * Math.log2(charset.length))
  };
}

// ---------------------------------------------------------------------------
// 加密与存储（自有格式：主密码经 scrypt 派生密钥，整体 AES-256-GCM 加密）
// ---------------------------------------------------------------------------
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32 };

function vaultPath() {
  return path.join(app.getPath('userData'), 'vault.pm');
}

function deriveKey(masterPassword, salt) {
  return crypto.scryptSync(masterPassword, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p
  });
}

function encryptVault(key, entries, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ entries }), 'utf8'),
    cipher.final()
  ]);
  return {
    format: 'PM_VAULT',
    version: 1,
    kdf: {
      algo: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p
    },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptVault(key, fileData) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(fileData.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(fileData.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(fileData.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

// 内存中的会话（解锁后驻留主进程，锁定即清空）
let session = null; // { key, salt, entries }

// 自动锁定：空闲超时后清空会话并通知渲染进程回到认证界面
const DEFAULT_AUTO_LOCK_MINUTES = 5;
let autoLockMinutes = DEFAULT_AUTO_LOCK_MINUTES;
let autoLockTimer = null;

function clearAutoLockTimer() {
  if (autoLockTimer) { clearTimeout(autoLockTimer); autoLockTimer = null; }
}

function resetAutoLockTimer() {
  clearAutoLockTimer();
  if (!session || !autoLockMinutes) return;
  autoLockTimer = setTimeout(() => {
    if (!session) return;
    session = null;
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('auto-locked');
  }, autoLockMinutes * 60 * 1000);
}

// 原子写入：tmp → fsync → 覆盖前保留上一版 .bak → rename
function persist() {
  if (!session) return;
  const fileData = encryptVault(session.key, session.entries, session.salt);
  const target = vaultPath();
  const tmp = target + '.tmp';
  const json = JSON.stringify(fileData, null, 2);

  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);                 // 改名之前先把数据刷到磁盘
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(target)) {
    fs.copyFileSync(target, target + '.bak'); // 保留上一次已知可用的版本
  }
  fs.renameSync(tmp, target);         // 失败会抛错 → 交给上层回滚
}

// 先改内存、写盘失败回滚，保证内存与磁盘一致；失败信息向上抛
function commit(nextEntries) {
  const previous = session.entries;
  session.entries = nextEntries;
  try {
    persist();
    return null;                      // 成功
  } catch (err) {
    session.entries = previous;       // 回滚
    return err;
  }
}

// 统一异常兜底：handler 抛错也以 { ok:false } 返回，不让 IPC reject
function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      return { ok: false, error: (err && err.message) || '操作失败' };
    }
  });
}

// ---------------------------------------------------------------------------
// TOTP（RFC 6238）
// ---------------------------------------------------------------------------
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input || '').replace(/[=\s-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output = [];
  for (const c of clean) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// 支持 otpauth:// URI 或纯 base32 secret
function parseTotp(input) {
  let secret = '';
  let algo = 'sha1';
  let digits = 6;
  let period = 30;
  if (/^otpauth:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname === 'totp') {
        secret = url.searchParams.get('secret') || '';
        const a = (url.searchParams.get('algorithm') || 'sha1').toLowerCase();
        algo = a === 'sha256' ? 'sha256' : a === 'sha512' ? 'sha512' : 'sha1';
        // 参数可能来自任意来源，非法值一律回退默认，避免 NaN/负数导致计算崩溃
        const d = parseInt(url.searchParams.get('digits') || '6', 10);
        const p = parseInt(url.searchParams.get('period') || '30', 10);
        digits = Number.isInteger(d) && d >= 6 && d <= 8 ? d : 6;
        period = Number.isInteger(p) && p > 0 ? p : 30;
      }
    } catch (_) {
      /* 解析失败时按纯 secret 处理 */
    }
  }
  if (!secret) secret = String(input || '').trim();
  return { secret, algo, digits, period };
}

function computeTotp(secret, period = 30, digits = 6, algo = 'sha1') {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algo, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits)
    .toString()
    .padStart(digits, '0');
  return {
    code,
    remaining: period - (Math.floor(Date.now() / 1000) % period)
  };
}

// ---------------------------------------------------------------------------
// IPC：保险库生命周期
// ---------------------------------------------------------------------------
ipcMain.handle('vault:getStatus', () => ({
  initialized: fs.existsSync(vaultPath()),
  unlocked: !!session,
  entryCount: session ? session.entries.length : 0
}));

safeHandle('vault:init', (_e, masterPassword) => {
  if (typeof masterPassword !== 'string' || masterPassword.length < 4) {
    return { ok: false, error: '主密码至少需要 4 个字符' };
  }
  if (fs.existsSync(vaultPath())) {
    return { ok: false, error: '保险库已存在' };
  }
  const salt = crypto.randomBytes(16);
  const key = deriveKey(masterPassword, salt);
  session = { key, salt, entries: [] };
  try {
    persist();
  } catch (err) {
    session = null;                   // 创建失败不留半状态
    return { ok: false, error: '创建保险库失败：' + err.message };
  }
  resetAutoLockTimer();
  return { ok: true };
});

safeHandle('vault:unlock', (_e, masterPassword) => {
  try {
    const fileData = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
    const key = deriveKey(
      masterPassword,
      Buffer.from(fileData.kdf.salt, 'base64')
    );
    const { entries } = decryptVault(key, fileData);
    session = { key, salt: Buffer.from(fileData.kdf.salt, 'base64'), entries };
    resetAutoLockTimer();
    return { ok: true, entries };
  } catch (_) {
    const bak = vaultPath() + '.bak';
    return {
      ok: false,
      error: fs.existsSync(bak)
        ? '主密码错误或保险库数据损坏（检测到上一版备份 vault.pm.bak）'
        : '主密码错误或保险库数据损坏'
    };
  }
});

ipcMain.handle('vault:lock', () => {
  session = null;
  clearAutoLockTimer();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC：条目增删改查
// ---------------------------------------------------------------------------
function requireUnlocked() {
  if (!session) throw new Error('保险库未解锁');
}

safeHandle('entry:list', () => {
  requireUnlocked();
  return session.entries;
});

safeHandle('entry:add', (_e, entry) => {
  requireUnlocked();
  const item = {
    id: crypto.randomUUID(),
    title: (entry && entry.title) || '',
    username: (entry && entry.username) || '',
    password: (entry && entry.password) || '',
    url: (entry && entry.url) || '',
    notes: (entry && entry.notes) || '',
    totp: (entry && entry.totp) || '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const err = commit([...session.entries, item]);
  if (err) return { ok: false, error: '保存失败：' + err.message };
  return { ok: true, entry: item };
});

safeHandle('entry:update', (_e, id, patch) => {
  requireUnlocked();
  const cur = session.entries.find((x) => x.id === id);
  if (!cur) return { ok: false, error: '条目不存在' };
  if (patch !== null && typeof patch !== 'object') {
    return { ok: false, error: '更新内容无效' };
  }
  const next = { ...cur };
  const allowed = ['title', 'username', 'password', 'url', 'notes', 'totp'];
  for (const k of allowed) {
    if (patch && k in patch) next[k] = patch[k];
  }
  next.updatedAt = Date.now();
  const err = commit(session.entries.map((x) => (x.id === id ? next : x)));
  if (err) return { ok: false, error: '保存失败：' + err.message };
  return { ok: true, entry: next };
});

safeHandle('entry:delete', (_e, id) => {
  requireUnlocked();
  const err = commit(session.entries.filter((x) => x.id !== id));
  if (err) return { ok: false, error: '删除失败：' + err.message };
  return { ok: true };
});

safeHandle('entry:totp', (_e, id) => {
  requireUnlocked();
  const e = session.entries.find((x) => x.id === id);
  if (!e || !e.totp) return { ok: false, error: '该条目未配置 TOTP' };
  const { secret, algo, digits, period } = parseTotp(e.totp);
  if (!secret) return { ok: false, error: '该条目的 TOTP 密钥为空' };
  return { ok: true, ...computeTotp(secret, period, digits, algo) };
});

// ---------------------------------------------------------------------------
// IPC：自动锁定
// ---------------------------------------------------------------------------
ipcMain.handle('session:activity', () => {
  resetAutoLockTimer();
  return true;
});

ipcMain.handle('session:getAutoLock', () => ({ autoLockMinutes }));

ipcMain.handle('session:setAutoLock', (_e, minutes) => {
  const n = parseInt(minutes, 10);
  autoLockMinutes = Number.isInteger(n) && n > 0 ? n : 0;
  resetAutoLockTimer();
  return { autoLockMinutes };
});

// ---------------------------------------------------------------------------
// IPC：导入导出（CSV / JSON）
// ---------------------------------------------------------------------------
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(entries) {
  const header = ['title', 'username', 'password', 'url', 'notes', 'totp'];
  const lines = [header.join(',')];
  for (const e of entries) lines.push(header.map((h) => csvEscape(e[h])).join(','));
  return lines.join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseCsvEntries(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const entries = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = rows[i][idx] ?? ''; });
    if (!obj.title && !obj.username && !obj.password) continue;
    entries.push(obj);
  }
  return entries;
}

function parseJsonText(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : (Array.isArray(data.entries) ? data.entries : []);
  return arr.filter((x) => x && typeof x === 'object');
}

function normalizeEntry(raw) {
  return {
    id: crypto.randomUUID(),
    title: String(raw.title ?? ''),
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
    url: String(raw.url ?? ''),
    notes: String(raw.notes ?? ''),
    totp: String(raw.totp ?? ''),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

safeHandle('io:export', async (_e, format) => {
  requireUnlocked();
  const win = BrowserWindow.getFocusedWindow();
  const ext = format === 'csv' ? 'csv' : 'json';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出条目',
    defaultPath: `密码导出-${new Date().toISOString().slice(0, 10)}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const content = format === 'csv'
    ? toCsv(session.entries)
    : JSON.stringify(session.entries, null, 2);
  fs.writeFileSync(filePath, format === 'csv' ? '\ufeff' + content : content, 'utf8');
  return { ok: true, count: session.entries.length, filePath };
});

safeHandle('io:import', async (_e, format) => {
  requireUnlocked();
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入条目',
    properties: ['openFile'],
    filters: [{ name: format === 'csv' ? 'CSV' : 'JSON', extensions: [format === 'csv' ? 'csv' : 'json'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const raw = fs.readFileSync(filePaths[0], 'utf8').replace(/^\ufeff/, '');
  let parsed;
  try {
    parsed = format === 'csv' ? parseCsvEntries(raw) : parseJsonText(raw);
  } catch (_) {
    return { ok: false, error: '文件格式无法解析，请确认选择正确的文件' };
  }
  const err = commit([...session.entries, ...parsed.map(normalizeEntry)]);
  if (err) return { ok: false, error: '导入失败：' + err.message };
  resetAutoLockTimer();
  return { ok: true, added: parsed.length };
});

// 加密备份（.pmbackup）：用主密码独立加密，绑定主密码而非当前库的 salt，
// 因此跨设备换主机后，用相同主密码即可恢复。
safeHandle('io:exportEncrypted', async (_e, masterPassword) => {
  requireUnlocked();
  if (typeof masterPassword !== 'string' || !masterPassword) {
    return { ok: false, error: '请输入主密码' };
  }
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出加密备份',
    defaultPath: `密码备份-${new Date().toISOString().slice(0, 10)}.pmbackup`,
    filters: [{ name: '加密备份', extensions: ['pmbackup'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const salt = crypto.randomBytes(16);
  const key = deriveKey(masterPassword, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ entries: session.entries }), 'utf8'),
    cipher.final()
  ]);
  const backup = {
    format: 'PM_BACKUP',
    version: 1,
    kdf: { algo: 'scrypt', salt: salt.toString('base64'), N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
    encryptedAt: Date.now(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');
  return { ok: true, count: session.entries.length, filePath };
});

safeHandle('io:importEncrypted', async (_e, masterPassword) => {
  requireUnlocked();
  if (typeof masterPassword !== 'string' || !masterPassword) {
    return { ok: false, error: '请输入主密码' };
  }
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '恢复加密备份',
    properties: ['openFile'],
    filters: [{ name: '加密备份', extensions: ['pmbackup'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };

  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  } catch (_) {
    return { ok: false, error: '备份文件无效或已损坏' };
  }
  if (backup.format !== 'PM_BACKUP') {
    return { ok: false, error: '不是有效的加密备份文件' };
  }
  // 字段校验放在派生密钥之前，避免畸形文件导致未捕获异常
  if (!backup.kdf || typeof backup.kdf.salt !== 'string' ||
      typeof backup.iv !== 'string' || typeof backup.tag !== 'string' ||
      typeof backup.data !== 'string') {
    return { ok: false, error: '备份文件结构不完整或已损坏' };
  }

  const key = deriveKey(masterPassword, Buffer.from(backup.kdf.salt, 'base64'));
  let entries;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(backup.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(backup.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
    entries = JSON.parse(plaintext).entries;
  } catch (_) {
    return { ok: false, error: '主密码错误，无法解密该备份' };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, error: '备份内容无效' };
  }

  const err = commit([...session.entries, ...entries.map(normalizeEntry)]);
  if (err) return { ok: false, error: '恢复失败：' + err.message };
  resetAutoLockTimer();
  return { ok: true, added: entries.length };
});

// ---------------------------------------------------------------------------
// IPC：密码生成 / 剪贴板
// ---------------------------------------------------------------------------
ipcMain.handle('gen:password', (_e, length, opts) => generatePassword(length, opts));

const CLIPBOARD_CLEAR_MS = 30 * 1000;
let clipboardTimer = null;

ipcMain.handle('clipboard:copy', (_e, text) => {
  if (typeof text !== 'string' || text.length === 0) return false;
  clipboard.writeText(text);
  if (clipboardTimer) clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => {
    if (clipboard.readText() === text) clipboard.clear();
  }, CLIPBOARD_CLEAR_MS);
  return true;
});

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 780,
    minHeight: 540,
    autoHideMenuBar: true,
    title: '密码管理器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  try {
    const tmp = vaultPath() + '.tmp'; // 清掉上次崩溃/断电残留的临时文件
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (_) { /* 清理失败不影响启动 */ }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});