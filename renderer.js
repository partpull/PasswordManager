// 注意：preload 通过 contextBridge 暴露的 window.api 是不可配置的全局属性，
// 这里不能再用 const api 同名声明（会触发 "Identifier 'api' has already been declared"，
// 导致整个脚本在解析期就中断），故重命名为 bridge。
const bridge = window.api;
const $ = (sel) => document.querySelector(sel);

const state = {
  entries: [],
  selectedId: null,
  search: '',
  editingId: null,
  totpTimer: null,
  showPassword: false
};

function setView(name) {
  $('#auth-view').hidden = name !== 'auth';
  $('#main-view').hidden = name !== 'main';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 统一调用：主进程异常 / 返回非 ok 都能给出提示，不再静默中断回调
async function call(promise, errEl) {
  try {
    const r = await promise;
    if (r && r.ok === false && !r.canceled) {
      const msg = r.error || '操作失败';
      if (errEl) errEl.textContent = msg; else alert(msg);
    }
    return r;
  } catch (err) {
    const msg = (err && err.message) || '操作失败，请重试';
    if (errEl) errEl.textContent = msg; else alert(msg);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 启动与认证
// ---------------------------------------------------------------------------
async function bootstrap() {
  const status = await bridge.getStatus();
  if (status.initialized) {
    $('#auth-title').textContent = '解锁保险库';
    $('#auth-hint').textContent = '输入主密码以解锁';
    $('#auth-confirm').hidden = true;
    $('#auth-submit').textContent = '解锁';
  } else {
    $('#auth-title').textContent = '创建主密码';
    $('#auth-hint').textContent = '首次使用，请设置主密码。请务必牢记，丢失后无法找回。';
    $('#auth-confirm').hidden = false;
    $('#auth-submit').textContent = '创建保险库';
  }
  setView('auth');
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#auth-password').value;
  const confirm = $('#auth-confirm').value;
  const status = await bridge.getStatus();
  $('#auth-error').textContent = '';
  let createdNew = false;

  if (!status.initialized) {
    if (pw.length < 4) { $('#auth-error').textContent = '主密码至少需要 4 个字符'; $('#auth-password').focus(); return; }
    if (!confirm) { $('#auth-error').textContent = '请再次输入确认密码'; $('#auth-confirm').focus(); return; }
    if (pw !== confirm) { $('#auth-error').textContent = '两次输入的密码不一致'; $('#auth-confirm').select(); return; }
    const r = await call(bridge.init(pw), $('#auth-error'));
    if (!r.ok) return;
    createdNew = true;
  } else {
    const r = await call(bridge.unlock(pw), $('#auth-error'));
    if (!r.ok) return;
    state.entries = r.entries;
  }
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  await enterMain();
  if (createdNew) {
    // 引导首次创建后立即导出备份，降低主密码遗失导致数据不可恢复的风险
    setTimeout(() => alert('保险库已创建。建议立即通过「设置 → 导出加密备份」保存一份离线备份，以防忘记主密码。'), 100);
  }
});

// 回车交互：创建模式下，在「主密码」框回车先把焦点移到「确认主密码」框，
// 避免直接触发表单提交而误报「请再次输入确认密码」。
$('#auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#auth-confirm').hidden) {
    e.preventDefault();
    $('#auth-confirm').focus();
  }
});
$('#auth-confirm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#auth-form').requestSubmit();
  }
});

async function enterMain() {
  const list = await call(bridge.listEntries());
  state.entries = Array.isArray(list) ? list : [];
  state.selectedId = null;
  setView('main');
  renderEntryList();
  $('#search').value = '';
  $('#search').focus();
}

// ---------------------------------------------------------------------------
// 列表与详情
// ---------------------------------------------------------------------------
function filteredEntries() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.entries;
  return state.entries.filter((e) =>
    [e.title, e.username, e.url].some((v) => (v || '').toLowerCase().includes(q))
  );
}

function renderEntryList() {
  const list = $('#entry-list');
  const items = filteredEntries();
  list.innerHTML = '';
  $('#empty').hidden = items.length > 0;

  for (const e of items) {
    const li = document.createElement('li');
    li.className = 'entry' + (e.id === state.selectedId ? ' active' : '');
    li.dataset.id = e.id;
    const name = e.title || '(未命名)';
    li.innerHTML =
      `<div class="entry-name">${escapeHtml(name)}</div>` +
      `<div class="entry-sub">${escapeHtml(e.username || e.url || '')}</div>` +
      (e.totp ? '<span class="badge">TOTP</span>' : '');
    li.addEventListener('click', () => selectEntry(e.id));
    list.appendChild(li);
  }
}

function selectEntry(id) {
  state.selectedId = id;
  renderEntryList();
  const e = state.entries.find((x) => x.id === id);
  if (e) renderDetail(e);
  startTotpTick();
}

function renderDetail(e) {
  $('#detail-empty').hidden = true;
  const c = $('#detail-content');
  c.hidden = false;

  const field = (label, value, key) => {
    if (!value) return '';
    return `<div class="field">
      <span class="field-label">${label}</span>
      <div class="field-row">
        <span class="field-value ${key === 'password' ? 'mono' : ''}">${escapeHtml(value)}</span>
        <button class="mini" data-copy="${escapeHtml(value)}">复制</button>
      </div>
    </div>`;
  };

  c.innerHTML =
    `<div class="detail-header">
      <h2>${escapeHtml(e.title || '(未命名)')}</h2>
      <div class="detail-actions">
        <button class="btn" id="detail-edit">编辑</button>
        <button class="btn danger" id="detail-delete">删除</button>
      </div>
    </div>` +
    field('用户名', e.username, 'username') +
    field('密码', e.password, 'password') +
    field('网址', e.url, 'url') +
    `<div id="detail-totp" ${e.totp ? '' : 'hidden'} class="field">
      <span class="field-label">两步验证码</span>
      <div class="totp-row">
        <span class="totp-code" id="detail-totp-code">------</span>
        <span class="totp-count" id="detail-totp-count"></span>
      </div>
    </div>` +
    (e.notes ? `<div class="field"><span class="field-label">备注</span><pre class="notes">${escapeHtml(e.notes)}</pre></div>` : '') +
    `<div class="field muted">更新时间：${new Date(e.updatedAt).toLocaleString()}</div>`;

  $('#detail-edit').addEventListener('click', () => openEntryModal(e));
  $('#detail-delete').addEventListener('click', () => deleteEntry(e));
}

function startTotpTick() {
  if (state.totpTimer) clearInterval(state.totpTimer);
  const e = state.entries.find((x) => x.id === state.selectedId);
  if (!e || !e.totp) return;
  const tick = async () => {
    const r = await bridge.getTotp(e.id);
    if (!r.ok || state.selectedId !== e.id) return;
    $('#detail-totp-code').textContent = r.code;
    $('#detail-totp-count').textContent = r.remaining + 's';
  };
  tick();
  state.totpTimer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// 复制（事件委托）
// ---------------------------------------------------------------------------
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-copy]');
  if (btn) {
    await bridge.copyToClipboard(btn.dataset.copy);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
});

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderEntryList();
});

// ---------------------------------------------------------------------------
// 条目弹窗
// ---------------------------------------------------------------------------
function openEntryModal(entry) {
  state.editingId = entry ? entry.id : null;
  $('#entry-modal-title').textContent = entry ? '编辑条目' : '新建条目';
  $('#entry-title').value = entry ? entry.title : '';
  $('#entry-username').value = entry ? entry.username : '';
  $('#entry-password').value = entry ? entry.password : '';
  $('#entry-url').value = entry ? entry.url : '';
  $('#entry-notes').value = entry ? entry.notes : '';
  $('#entry-totp').value = entry ? entry.totp : '';
  state.showPassword = false;
  $('#entry-password').type = 'password';
  $('#entry-modal').hidden = false;
}

function closeEntryModal() {
  $('#entry-modal').hidden = true;
}

$('#entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    title: $('#entry-title').value.trim(),
    username: $('#entry-username').value,
    password: $('#entry-password').value,
    url: $('#entry-url').value,
    notes: $('#entry-notes').value,
    totp: $('#entry-totp').value
  };
  const r = state.editingId
    ? await call(bridge.updateEntry(state.editingId, data))
    : await call(bridge.addEntry(data));
  if (!r || r.ok !== true) return;          // 失败：弹窗不关、输入不丢
  if (!state.editingId) state.selectedId = r.entry.id;
  const list = await call(bridge.listEntries());
  state.entries = Array.isArray(list) ? list : state.entries;
  closeEntryModal();
  renderEntryList();
  if (state.selectedId) selectEntry(state.selectedId);
});

// 弹窗内小按钮：显示密码 / 生成填入
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  if (action === 'toggle-password') {
    state.showPassword = !state.showPassword;
    $('#entry-password').type = state.showPassword ? 'text' : 'password';
    t.textContent = state.showPassword ? '隐藏' : '显示';
  } else if (action === 'gen-fill') {
    const r = await bridge.generatePassword(16, {});
    $('#entry-password').value = r.password;
    $('#entry-password').type = 'text';
    const showBtn = document.querySelector('[data-action="toggle-password"]');
    if (showBtn) showBtn.textContent = '隐藏';
    state.showPassword = true;
  }
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------
async function deleteEntry(entry) {
  if (!confirm(`确定要删除「${entry.title || '(未命名)'}」吗？此操作不可恢复。`)) return;
  const r = await call(bridge.deleteEntry(entry.id));
  if (!r || r.ok !== true) return;
  const list = await call(bridge.listEntries());
  state.entries = Array.isArray(list) ? list : state.entries;
  state.selectedId = null;
  if (state.totpTimer) { clearInterval(state.totpTimer); state.totpTimer = null; }
  $('#detail-content').hidden = true;
  $('#detail-empty').hidden = false;
  renderEntryList();
}

// ---------------------------------------------------------------------------
// 密码生成器弹窗
// ---------------------------------------------------------------------------
$('#gen-length').addEventListener('input', () => {
  $('#gen-length-range').value = $('#gen-length').value;
  regenerate();
});
$('#gen-length-range').addEventListener('input', () => {
  $('#gen-length').value = $('#gen-length-range').value;
  regenerate();
});
document.querySelectorAll('.checks input').forEach((el) => el.addEventListener('change', regenerate));

async function regenerate() {
  const length = parseInt($('#gen-length').value, 10) || 16;
  const opts = {
    upper: $('#gen-upper').checked,
    lower: $('#gen-lower').checked,
    digits: $('#gen-digits').checked,
    symbols: $('#gen-symbols').checked
  };
  const r = await bridge.generatePassword(length, opts);
  $('#gen-output').textContent = r.password;
  $('#gen-bits').textContent = '强度约 ' + r.bits + ' bit';
}

$('#gen-regen').addEventListener('click', regenerate);
$('#gen-copy').addEventListener('click', () => {
  bridge.copyToClipboard($('#gen-output').textContent);
  $('#gen-copy').textContent = '已复制';
  setTimeout(() => { $('#gen-copy').textContent = '复制'; }, 1200);
});

// ---------------------------------------------------------------------------
// 工具栏与弹窗开关
// ---------------------------------------------------------------------------
$('#btn-new').addEventListener('click', () => openEntryModal(null));
$('#btn-generator').addEventListener('click', () => {
  $('#generator-modal').hidden = false;
  regenerate();
});
$('#btn-lock').addEventListener('click', async () => {
  if (state.totpTimer) { clearInterval(state.totpTimer); state.totpTimer = null; }
  state.entries = [];
  state.selectedId = null;
  await bridge.lock();
  await bootstrap();
});

document.querySelectorAll('[data-close]').forEach((el) => {
  el.addEventListener('click', () => {
    const name = el.dataset.close;
    if (name === 'entry') closeEntryModal();
    if (name === 'generator') $('#generator-modal').hidden = true;
    if (name === 'settings') $('#settings-modal').hidden = true;
    if (name === 'backup') $('#backup-modal').hidden = true;
  });
});

// ---------------------------------------------------------------------------
// 自动锁定：活动上报，空闲超时后被锁定时回到认证界面
// ---------------------------------------------------------------------------
let lastActivityReport = 0;
function reportActivity() {
  const now = Date.now();
  if (now - lastActivityReport < 1000) return;
  lastActivityReport = now;
  bridge.reportActivity();
}
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) =>
  document.addEventListener(ev, reportActivity, { passive: true })
);

bridge.onAutoLocked(() => {
  if (state.totpTimer) { clearInterval(state.totpTimer); state.totpTimer = null; }
  state.entries = [];
  state.selectedId = null;
  $('#search').value = '';
  bootstrap();
});

// ---------------------------------------------------------------------------
// 设置弹窗（自动锁定 + 导入导出）
// ---------------------------------------------------------------------------
async function openSettings() {
  const cfg = await bridge.getAutoLock();
  $('#auto-lock-select').value = String(cfg.autoLockMinutes);
  $('#settings-modal').hidden = false;
}

$('#btn-settings').addEventListener('click', openSettings);
$('#btn-import').addEventListener('click', openSettings);
$('#btn-export').addEventListener('click', openSettings);

$('#auto-lock-select').addEventListener('change', (e) => {
  bridge.setAutoLock(parseInt(e.target.value, 10));
});

async function doExport(format) {
  const r = await bridge.exportData(format);
  if (r.ok) {
    alert(`已导出 ${r.count} 条条目到：\n${r.filePath}`);
  } else if (!r.canceled) {
    alert('导出失败。');
  }
}

async function doImport(format) {
  const r = await bridge.importData(format);
  if (r.ok) {
    state.entries = await bridge.listEntries();
    renderEntryList();
    alert(`成功导入 ${r.added} 条条目。`);
  } else if (!r.canceled) {
    alert(r.error || '导入失败。');
  }
}

$('#btn-export-csv').addEventListener('click', () => doExport('csv'));
$('#btn-export-json').addEventListener('click', () => doExport('json'));
$('#btn-import-csv').addEventListener('click', () => doImport('csv'));
$('#btn-import-json').addEventListener('click', () => doImport('json'));

// ---------------------------------------------------------------------------
// 加密备份：先弹出主密码确认，再执行导出/恢复
// ---------------------------------------------------------------------------
let backupMode = null;

function openBackupPrompt(mode) {
  backupMode = mode;
  $('#backup-password').value = '';
  $('#backup-error').textContent = '';
  $('#backup-modal-title').textContent = mode === 'export' ? '导出加密备份' : '恢复加密备份';
  $('#backup-modal-hint').textContent = mode === 'export'
    ? '输入主密码以加密备份，跨设备可用相同主密码恢复'
    : '输入该备份创建时使用的主密码';
  $('#backup-modal').hidden = false;
  setTimeout(() => $('#backup-password').focus(), 50);
}

$('#btn-backup').addEventListener('click', () => openBackupPrompt('export'));
$('#btn-restore').addEventListener('click', () => openBackupPrompt('import'));

$('#backup-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#backup-confirm').click();
});

$('#backup-confirm').addEventListener('click', async () => {
  const pw = $('#backup-password').value;
  if (!pw) { $('#backup-error').textContent = '请输入主密码'; return; }
  const r = backupMode === 'export'
    ? await bridge.exportEncrypted(pw)
    : await bridge.importEncrypted(pw);
  if (r.ok) {
    $('#backup-modal').hidden = true;
    if (backupMode === 'export') {
      alert(`已导出加密备份 ${r.count} 条条目到：\n${r.filePath}`);
    } else {
      state.entries = await bridge.listEntries();
      renderEntryList();
      alert(`成功恢复 ${r.added} 条条目。`);
    }
  } else if (!r.canceled) {
    $('#backup-error').textContent = r.error || '操作失败';
  }
});

bootstrap();