// 内核回归测试：响应钩子分发、页面路由激活/收尾、筛选栏注入。
// 用最小 DOM 桩在 vm 沙箱里跑真实脚本源码，不引入任何依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../qushubao-userscripts.user.js', import.meta.url), 'utf8');
const TARGET = '/mallQuan/taskExecuteManagementV2';

function makeElement(tag = 'div', rect = null) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    classList: { add() { }, remove() { }, contains: () => false },
    appendChild(c) { el.children.push(c); return c; },
    insertAdjacentElement() { },
    setAttribute() { },
    removeAttribute() { },
    hasAttribute: () => false,
    addEventListener() { },
    removeEventListener() { },
    remove() { },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  // 只有显式给了几何信息的元素才像是"已布局"的，其余保持无 getBoundingClientRect
  if (rect) {
    el.getBoundingClientRect = () => ({
      top: rect.top, height: rect.height, bottom: rect.top + rect.height
    });
  }
  return el;
}

// 表格桩：只实现脚本真正用到的查询口径（表头 th / 行 / 单元格属性）
function makeTable({ headers, rows }) {
  const ths = headers.map(text => {
    const th = makeElement('th');
    th.textContent = text;
    return th;
  });
  const trs = rows.map(makeRow);
  const table = makeElement('div');
  table.className = 'ant-table';
  table.querySelectorAll = sel => {
    if (sel === '.ant-table-thead th') return ths;
    if (sel === '.ant-table-tbody tr.ant-table-row') return trs;
    return [];
  };
  table.rows = trs;
  return table;
}

function makeRow({ key, cells }) {
  const attrs = { 'data-row-key': key };
  const tds = cells.map(text => {
    const td = makeElement('td');
    td.textContent = text;
    const own = {};
    const classes = new Set();
    td.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) };
    td.setAttribute = (k, v) => { own[k] = v; };
    td.getAttribute = k => (k in own ? own[k] : null);
    td.hasAttribute = k => k in own;
    td.removeAttribute = k => { delete own[k]; };
    td.querySelector = sel => {
      if (sel === '.qsb-status-bar') {
        return td.children.find(c => c.className === 'qsb-status-bar') || null;
      }
      return null;
    };
    return td;
  });

  const row = makeElement('tr');
  row.className = 'ant-table-row';
  row.getAttribute = k => (k in attrs ? attrs[k] : null);
  row.setAttribute = (k, v) => { attrs[k] = v; };
  row.hasAttribute = k => k in attrs;
  row.removeAttribute = k => { delete attrs[k]; };
  row.querySelectorAll = sel => (sel === 'td' ? tds : []);
  row.closest = sel => (sel === '.ant-table-row' ? row : null);
  row.tds = tds;
  return row;
}

function createEnv({ pathname = '/home', withForm = false, layout = null, table = null } = {}) {
  const logs = [];
  const timers = [];
  const fetchCalls = [];
  const bar = { value: null };
  let cloneCalls = 0;
  let clock = 0;

  const body = makeElement('body');
  const head = makeElement('head');
  const forms = [];

  if (withForm) {
    const form = makeElement('form');
    const btn = makeElement('button', layout ? layout.ref : null);
    btn.textContent = '重置';
    btn.parentElement = makeElement('div');
    btn.parentElement.insertAdjacentElement = (_pos, node) => {
      if (node && node.className === 'qsb-filter-bar') bar.value = node;
    };
    form.querySelectorAll = sel => (sel === 'button' ? [btn] : []);
    forms.push(form);
  }

  const tables = table ? [makeTable(table)] : [];
  const document = {
    readyState: 'complete',
    cookie: '',
    body,
    head,
    documentElement: makeElement('html'),
    getElementById: () => null,
    createElement: tag => makeElement(tag, layout && String(tag).toUpperCase() === 'INPUT' ? layout.input : null),
    querySelector: sel => (sel === '.qsb-filter-bar' ? bar.value : sel === '.ant-table' ? (tables[0] || null) : null),
    querySelectorAll: sel => {
      if (sel === '.ant-form') return forms;
      if (sel === '.ant-table') return tables;
      return [];
    },
    addEventListener() { },
    removeEventListener() { },
  };

  const location = { pathname };
  const setPath = url => { location.pathname = new URL(url, 'https://dep.ai-indeed.com').pathname; };

  class FakeXHR {
    constructor() { this.listeners = {}; this.responseText = ''; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { (this.listeners[type] || []).forEach(fn => fn.call(this)); }
  }
  FakeXHR.prototype.open = function () { };
  FakeXHR.prototype.setRequestHeader = function () { };
  FakeXHR.prototype.send = function () { };

  const ctx = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    },
    location,
    history: {
      pushState(_s, _t, url) { if (url) setPath(url); },
      replaceState(_s, _t, url) { if (url) setPath(url); },
    },
    document,
    XMLHttpRequest: FakeXHR,
    fetch: (...args) => {
      fetchCalls.push(args);
      return Promise.resolve({
        clone: () => ({ json: () => { cloneCalls++; return Promise.resolve({ code: '10000' }); } }),
      });
    },
    MutationObserver: class { observe() { } disconnect() { } },
    Headers: class { get() { return null; } },
    FormData: class { },
    AbortController: class { constructor() { this.signal = {}; } abort() { } },
    setTimeout: (fn, ms = 0) => { timers.push({ fn, due: clock + ms }); return timers.length; },
    clearTimeout: () => { },
    setInterval: () => 0,
    addEventListener() { },
    removeEventListener() { },
    URL,
  };
  ctx.window = ctx;

  const context = vm.createContext(ctx);

  const flush = (limit = 300) => {
    let n = 0;
    while (timers.length && n++ < limit) {
      timers.sort((a, b) => a.due - b.due);
      const t = timers.shift();
      clock = Math.max(clock, t.due);
      t.fn();
    }
  };

  return {
    logs,
    fetchCalls,
    FakeXHR,
    bar,
    get table() { return tables[0] || null; },
    get cloneCalls() { return cloneCalls; },
    boot() { vm.runInContext(SRC, context); flush(); },
    run() { vm.runInContext(SRC, context); },
    flush,
    push(url) { ctx.history.pushState({}, '', url); flush(); },
    fetch(...args) { return ctx.fetch(...args); },
  };
}

const countLogs = (logs, needle) => logs.filter(l => l.includes(needle)).length;

test('响应钩子：命中 /job/record/new 时挂一次 load 监听', () => {
  const env = createEnv({ pathname: TARGET });
  env.boot();
  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.send('{"dateTime":"2026-11-08"}');
  assert.equal((xhr.listeners.load || []).length, 1);
});

test('响应钩子：未命中的接口完全不介入', () => {
  const env = createEnv({ pathname: TARGET });
  env.boot();
  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/detail/new');
  xhr.send('{}');
  assert.equal((xhr.listeners.load || []).length, 0);
});

test('响应钩子：fetch 命中时读取克隆响应，未命中时不读取', async () => {
  const env = createEnv({ pathname: TARGET });
  env.boot();
  const tick = () => new Promise(resolve => setImmediate(resolve));

  await env.fetch('/frameWorkPortal/opt/qymall/1.0.0/job/record/new', { body: '{}' });
  await tick();
  assert.equal(env.cloneCalls, 1);

  await env.fetch('/frameWorkPortal/opt/qymall/1.0.0/job/record/detail/new', { body: '{}' });
  await tick();
  assert.equal(env.cloneCalls, 1);
});

test('路由：只在目标页激活，同路径重复跳转不重复激活', () => {
  const env = createEnv({ pathname: '/home', withForm: true });
  env.boot();
  assert.equal(countLogs(env.logs, '目标页面已激活'), 0);

  env.push(TARGET);
  assert.equal(countLogs(env.logs, '目标页面已激活'), 1);
  assert.equal(countLogs(env.logs, '筛选栏已注入'), 1);

  env.push(`${TARGET}?tab=2`);
  assert.equal(countLogs(env.logs, '目标页面已激活'), 1);
  assert.equal(countLogs(env.logs, '筛选栏已注入'), 1);
});

test('筛选栏：高度与垂直中心按同行原生控件实测值校正', () => {
  // 站点控件 36px 高（top 100），脚本写死 32px、还低了一截（top 114）
  const env = createEnv({
    pathname: TARGET,
    withForm: true,
    layout: { ref: { top: 100, height: 36 }, input: { top: 114, height: 32 } },
  });
  env.boot();

  const bar = env.bar.value;
  assert.ok(bar, '筛选栏应已注入');
  const input = bar.children[0].children[0];   // inputWrap > input
  assert.equal(input.style.height, '36px', '高度应跟随主题控件，而不是写死 32px');
  assert.equal(bar.style.top, '-12px', '中心线差 12px，应整体上移补偿');
});

test('状态列归属：只绑「取数执行」列，「数据入库」的“失败”不算状态格', () => {
  const env = createEnv({
    pathname: TARGET,
    withForm: true,
    table: {
      headers: ['计划名称', '店铺', '最近运行开始时间', '最近运行结束时间', '取数执行', '数据入库', '数据校验', '操作'],
      rows: [
        // 取数执行=已完成，但数据入库是"失败"——旧实现会把这格当成状态格
        { key: 'job-a', cells: ['计划A', '店铺A', '10:00', '10:01', '已完成', '失败', '-', '运行详情'] },
        { key: 'job-b', cells: ['计划B', '店铺B', '10:02', '10:03', '运行失败', '失败', '-', '运行详情'] },
      ],
    },
  });
  env.boot();

  const [rowA, rowB] = env.table.rows;
  assert.equal(rowA.tds[4].getAttribute('data-job-uuid'), null, '已完成 不挂浮层');
  assert.equal(rowA.tds[5].getAttribute('data-job-uuid'), null, '数据入库 不得被当成状态格');
  assert.equal(rowB.tds[4].getAttribute('data-job-uuid'), 'job-b', '运行失败 应绑到取数执行列');
  assert.equal(rowB.tds[5].getAttribute('data-job-uuid'), null, '数据入库 仍不得被误绑');
});

test('路由：离开后清空激活态，再回来重新激活', () => {
  const env = createEnv({ pathname: '/home', withForm: true });
  env.boot();

  env.push(TARGET);
  assert.equal(countLogs(env.logs, '目标页面已激活'), 1);

  env.bar.value = null; // 路由切换时页面容器被销毁
  env.push('/mallQuan/other');
  env.push(TARGET);
  assert.equal(countLogs(env.logs, '目标页面已激活'), 2);
});

test('路由：表单迟迟不出现时按上限重试并告警', () => {
  const env = createEnv({ pathname: TARGET, withForm: false });
  env.boot();
  assert.equal(countLogs(env.logs, '目标页面已激活'), 1);
  assert.equal(countLogs(env.logs, '超时：未找到目标表单'), 1);
});

test('路由：离开后不再继续重试注入', () => {
  const env = createEnv({ pathname: TARGET, withForm: false });
  env.run();
  env.flush(1);                 // 只走到激活并排下第一次重试
  assert.equal(countLogs(env.logs, '目标页面已激活'), 1);

  env.push('/mallQuan/other');  // 离开：应作废旧循环，重试不得继续
  assert.equal(countLogs(env.logs, '超时：未找到目标表单'), 0);
});
