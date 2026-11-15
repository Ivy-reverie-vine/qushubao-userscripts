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
    appendChild(c) {
      if (c) c.parentElement = el;
      el.children.push(c);
      return c;
    },
    insertAdjacentElement() { },
    setAttribute() { },
    removeAttribute() { },
    hasAttribute: () => false,
    addEventListener() { },
    removeEventListener() { },
    remove() {
      if (el.parentElement && el.parentElement.children) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
      }
    },
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
  row.querySelectorAll = sel => {
    if (sel === 'td') return tds;
    if (sel === '.qsb-status-bar') {
      const bars = [];
      tds.forEach(td => {
        const b = td.querySelector('.qsb-status-bar');
        if (b) bars.push(b);
      });
      return bars;
    }
    if (sel === '.qsb-status-cell') {
      return tds.filter(td => td.classList.contains('qsb-status-cell'));
    }
    return [];
  };
  row.querySelector = sel => {
    if (sel === '.qsb-status-bar') {
      for (const td of tds) {
        const b = td.querySelector('.qsb-status-bar');
        if (b) return b;
      }
    }
    return null;
  };
  row.closest = sel => (sel === '.ant-table-row' ? row : null);
  row.tds = tds;
  return row;
}

function createEnv({
  pathname = '/home',
  withForm = false,
  layout = null,
  table = null,
  initialStorage = {},
  initialLocalStorage = {},
  onFetch = null,
  customDocument = null,
} = {}) {
  const logs = [];
  const timers = [];
  const fetchCalls = [];
  const bar = { value: null };
  const windowListeners = {};
  const docListeners = {};
  const observerInstances = [];
  let cloneCalls = 0;
  let clock = 0;

  const sessionStore = { ...initialStorage };
  const sessionStorage = {
    getItem: k => (k in sessionStore ? sessionStore[k] : null),
    setItem: (k, v) => { sessionStore[k] = String(v); },
    removeItem: k => { delete sessionStore[k]; },
    clear: () => { for (const k in sessionStore) delete sessionStore[k]; },
    get length() { return Object.keys(sessionStore).length; },
    key: i => Object.keys(sessionStore)[i] || null,
  };

  const localStore = { ...initialLocalStorage };
  const localStorage = {
    getItem: k => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = String(v); },
    removeItem: k => { delete localStore[k]; },
    clear: () => { for (const k in localStore) delete localStore[k]; },
    get length() { return Object.keys(localStore).length; },
    key: i => Object.keys(localStore)[i] || null,
  };

  const body = customDocument ? customDocument.body : makeElement('body');
  const head = customDocument ? customDocument.head : makeElement('head');
  const forms = [];

  if (withForm && !customDocument) {
    const form = makeElement('form');
    const btn = makeElement('button', layout ? layout.ref : null);
    btn.textContent = '重置';
    btn.parentElement = makeElement('div');
    btn.parentElement.insertAdjacentElement = (_pos, node) => {
      if (node && node.className === 'qsb-filter-bar') {
        bar.value = node;
        node.remove = () => { bar.value = null; };
      }
    };
    form.querySelectorAll = sel => (sel === 'button' ? [btn] : []);
    forms.push(form);
  }

  const tables = table ? [makeTable(table)] : [];
  const document = customDocument || {
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
      if (sel.includes('.qsb-filter-bar') || sel.includes('.qsb-filter-form-item')) {
        return bar.value ? [bar.value] : [];
      }
      return [];
    },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
    },
  };
  if (customDocument) {
    const origAdd = customDocument.addEventListener.bind(customDocument);
    const origRem = customDocument.removeEventListener.bind(customDocument);
    customDocument.addEventListener = (type, fn, opts) => {
      (docListeners[type] ||= []).push(fn);
      return origAdd(type, fn, opts);
    };
    customDocument.removeEventListener = (type, fn, opts) => {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
      return origRem(type, fn, opts);
    };
  }

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

  class FakeObserver {
    constructor(cb) {
      this.cb = cb;
      this.connected = false;
      observerInstances.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  }

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
    sessionStorage,
    localStorage,
    NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 1280,
    innerHeight: 800,
    fetch: (...args) => {
      const url = args[0] || '';
      let body = {};
      try {
        body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : (args[1]?.body || {});
      } catch (_) { }
      fetchCalls.push({ args, url: String(url), body, at: clock, 0: args[0], 1: args[1] });

      let jsonRes = onFetch ? onFetch(String(url), body) : null;
      if (!jsonRes) {
        jsonRes = { code: '10000', bizData: {} };
        if (typeof url === 'string') {
          if (url.includes('/job/record/detail/new')) {
            jsonRes = { code: '10000', bizData: { records: [{ exeOrderUuid: 'order-' + (body.jobUuid || '1') }] } };
          } else if (url.includes('/job/record/work/list')) {
            jsonRes = { code: '10000', bizData: [{ workUuid: '1855901234567890123', rpaStatus: 3 }] };
          } else if (url.includes('/work/result/new')) {
            jsonRes = {
              code: '10000',
              bizData: {
                output: {
                  result: [
                    { errCode: '2001', blockName: '登录流程', shopName: '测试店铺', errMessage: '异常元素: 验证码滑块 # 滑块验证失败 【运行时间 15s】' }
                  ]
                }
              }
            };
          }
        }
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(jsonRes),
        clone: () => ({ json: () => { cloneCalls++; return Promise.resolve(jsonRes); } }),
      });
    },
    MutationObserver: FakeObserver,
    Headers: class { get() { return null; } },
    FormData: class { },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    setTimeout: (fn, ms = 0) => { timers.push({ fn, due: clock + ms }); return timers.length; },
    clearTimeout: () => { },
    setInterval: () => 0,
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (windowListeners[type]) {
        windowListeners[type] = windowListeners[type].filter(f => f !== fn);
      }
    },
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

  const flushAsync = async (limit = 300) => {
    let n = 0;
    while (timers.length && n++ < limit) {
      timers.sort((a, b) => a.due - b.due);
      const t = timers.shift();
      clock = Math.max(clock, t.due);
      t.fn();
      await new Promise(r => setImmediate(r));
    }
  };

  return {
    logs,
    fetchCalls,
    FakeXHR,
    bar,
    sessionStore,
    localStore,
    windowListeners,
    docListeners,
    observerInstances,
    get clock() { return clock; },
    get table() { return tables[0] || null; },
    get cloneCalls() { return cloneCalls; },
    boot() { vm.runInContext(SRC, context); flush(); },
    run() { vm.runInContext(SRC, context); },
    flush,
    flushAsync,
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

test('生命周期：离开页面时物理移除筛选栏并清理 resize 监听器与 observer', () => {
  const env = createEnv({ pathname: TARGET, withForm: true });
  env.boot();

  assert.ok(env.bar.value, '初始激活应成功注入筛选栏');
  assert.equal((env.windowListeners.resize || []).length, 1, '应挂载 window resize 监听');

  // 离开页面
  env.push('/mallQuan/other');
  assert.equal(env.bar.value, null, 'teardown 应物理移除筛选栏节点');
  assert.equal((env.windowListeners.resize || []).length, 0, 'teardown 应解除 window resize 监听');
  const connectedObservers = env.observerInstances.filter(o => o.connected);
  assert.equal(connectedObservers.length, 0, 'teardown 应断开表格 MutationObserver');

  // 重新进入
  env.push(TARGET);
  assert.ok(env.bar.value, '重新进入页面应顺利再次注入筛选栏');
  assert.equal((env.windowListeners.resize || []).length, 1, '重新进入应重新挂载 resize 监听');
});

test('缓存机制：支持按日期隔离缓存且切换日期不丢弃旧缓存，切回旧日期直接复用', async () => {
  const env = createEnv({ pathname: TARGET });
  env.boot();

  // 1. 发送 2026-11-10 列表请求
  const xhr1 = new env.FakeXHR();
  xhr1.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr1.responseText = JSON.stringify({
    code: '10000',
    bizData: {
      records: [
        { jobUuid: 'job-aaa', rpaStatus: 3, lastStartTime: '2026-11-10 09:00:00', lastEndTime: '2026-11-10 09:10:00' }
      ]
    }
  });
  xhr1.send(JSON.stringify({ dateTime: '2026-11-10' }));
  xhr1.fire('load');

  // 等待预加载 worker 走完（L2, L3, L4）
  await env.flushAsync();

  // 验证：已自动写入 2026-11-10:job-aaa 的 sessionStorage
  assert.ok(env.sessionStore['qsb_job_2026-11-10:job-aaa'], '预加载完成后应写入 sessionStorage');
  const cached1 = JSON.parse(env.sessionStore['qsb_job_2026-11-10:job-aaa']);
  assert.equal(cached1.counts['2xxx'], 1);
  const initialFetchCount = env.fetchCalls.length;
  assert.ok(initialFetchCount >= 3, '应经历 L2, L3, L4 请求');

  // 2. 发送 2026-11-11 列表请求（切换日期）
  const xhr2 = new env.FakeXHR();
  xhr2.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr2.responseText = JSON.stringify({
    code: '10000',
    bizData: {
      records: [
        { jobUuid: 'job-bbb', rpaStatus: 3, lastStartTime: '2026-11-11 09:00:00', lastEndTime: '2026-11-11 09:10:00' }
      ]
    }
  });
  xhr2.send(JSON.stringify({ dateTime: '2026-11-11' }));
  xhr2.fire('load');
  await env.flushAsync();

  assert.ok(env.sessionStore['qsb_job_2026-11-11:job-bbb'], '新日期应有新缓存');
  assert.ok(env.sessionStore['qsb_job_2026-11-10:job-aaa'], '旧日期缓存未被丢弃');

  // 记录切回前的 fetch 调用数
  const beforeSwitchBackFetches = env.fetchCalls.length;

  // 3. 再次切回 2026-11-10（同一 jobUuid、同一执行起止时间）
  const xhr3 = new env.FakeXHR();
  xhr3.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr3.responseText = JSON.stringify({
    code: '10000',
    bizData: {
      records: [
        { jobUuid: 'job-aaa', rpaStatus: 3, lastStartTime: '2026-11-10 09:00:00', lastEndTime: '2026-11-10 09:10:00' }
      ]
    }
  });
  xhr3.send(JSON.stringify({ dateTime: '2026-11-10' }));
  xhr3.fire('load');
  await env.flushAsync();

  // 验证：切回 2026-11-10 时直接命中缓存，没有产生任何新的 L2/L3/L4 fetch 请求！
  assert.equal(env.fetchCalls.length, beforeSwitchBackFetches, '切回旧日期后完全复用缓存，不应发起新 fetch 请求');
});

test('缓存机制：workUuid 失败信息写入 sessionStorage 并在后续请求中直接复用跳过 L4', async () => {
  const snowflakeWorkUuid = '1855901234567890123'; // 19位雪花ID纯字符串
  const cachedWorkDetails = [
    {
      errCode: '2001',
      shopName: '测试店铺',
      category: '2xxx',
      action: '登录流程',
      reason: '滑块验证失败',
      target: '验证码滑块',
      runTime: '15s',
      rawMsg: '异常元素: 验证码滑块 # 滑块验证失败 【运行时间 15s】'
    }
  ];

  // 在 sessionStorage 中预置已完成的不可变 workUuid 失败块
  const env = createEnv({
    pathname: TARGET,
    initialStorage: {
      [`qsb_work_${snowflakeWorkUuid}`]: JSON.stringify(cachedWorkDetails)
    }
  });
  env.boot();

  // 发起列表响应，返回包含该 workUuid 的 job
  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.responseText = JSON.stringify({
    code: '10000',
    bizData: {
      records: [
        { jobUuid: 'job-fresh-run', rpaStatus: 3, lastStartTime: '2026-11-12 10:00:00', lastEndTime: '2026-11-12 10:05:00' }
      ]
    }
  });
  xhr.send(JSON.stringify({ dateTime: '2026-11-12' }));
  xhr.fire('load');

  await env.flushAsync();

  // 验证：L2 /job/record/detail/new 和 L3 /job/record/work/list 被调用，但 L4 /work/result/new 被完全跳过（命中 workUuid 缓存）
  const l4Calls = env.fetchCalls.filter(call => String(call[0] || '').includes('/work/result/new'));
  assert.equal(l4Calls.length, 0, '命中 workUuid 缓存时严禁调用 L4 详情接口');

  // 并且最终 job 聚合结果能正确生成
  assert.ok(env.sessionStore['qsb_job_2026-11-12:job-fresh-run'], '应生成 job 聚合缓存');
  const jobCache = JSON.parse(env.sessionStore['qsb_job_2026-11-12:job-fresh-run']);
  assert.equal(jobCache.counts['2xxx'], 1);
  assert.equal(typeof snowflakeWorkUuid, 'string');
  assert.equal(snowflakeWorkUuid.length, 19, '19位雪花ID必须保持字符串长度');
});

test('行复用机制：虚拟滚动/分页重用 tr 节点时不应残留脏数据或旧 jobUuid', () => {
  const tableData = {
    headers: ['店铺名称', '取数执行'],
    rows: [
      { key: 'job-111', cells: ['店铺A', '失败'] }
    ]
  };
  const env = createEnv({ pathname: TARGET, table: tableData });
  env.boot();

  // 1. 模拟初始行渲染为 job-111
  const row = env.table.rows[0];
  const td = row.tds[1];
  td.classList.add('qsb-status-cell');
  td.setAttribute('data-job-uuid', 'job-111');
  const bar = makeElement('span');
  bar.className = 'qsb-status-bar';
  bar.innerHTML = '<span class="qsb-bar-seg qsb-seg-1xxx">1</span>';
  td.appendChild(bar);

  assert.equal(td.children.length, 1);
  assert.equal(row.getAttribute('data-row-key'), 'job-111');

  // 2. 模拟前端框架更新行内容为 job-222（但复用了同一个 tr DOM 节点）
  row.setAttribute('data-row-key', 'job-222');
  td.textContent = '已完成'; // 变成了已完成任务

  // 触发 DOM 变更或定时重绑
  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.responseText = JSON.stringify({
    code: '10000',
    bizData: { records: [{ jobUuid: 'job-222', rpaStatus: 5 }] }
  });
  xhr.send(JSON.stringify({ dateTime: '2026-11-12' }));
  xhr.fire('load');

  env.flush();

  // 验证：由于 job-222 是已完成行，旧 job-111 残留的 qsb-status-bar 必须被彻底清除！
  const remainingBar = td.querySelector('.qsb-status-bar');
  assert.equal(remainingBar, null, '已完成行不得残留任何旧状态色标');
});

test('生命周期：离开页面后定时器被清空且不向其它页面 DOM 注入', () => {
  const env = createEnv({ pathname: TARGET, withForm: true });
  env.boot();

  // 离开到数据中心
  env.push('/mallQuan/dataCenter');

  // 模拟列表请求返回（可能存在跨页未完成的请求）
  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.responseText = JSON.stringify({
    code: '10000',
    bizData: { records: [{ jobUuid: 'job-stale', rpaStatus: 3 }] }
  });
  xhr.send(JSON.stringify({ dateTime: '2026-11-12' }));
  xhr.fire('load');

  env.flush();

  // 验证：离开 taskExecute 后，不会在非激活页面执行 tooltip 挂载或注入
  assert.equal(countLogs(env.logs, '筛选栏已注入'), 1, '离开后不应再次注入');
});

// ═══════════════════════════════════════════════════════════════
// 机器人自定义列测试（基于树形 DOM 桩与选择器引擎）
// ═══════════════════════════════════════════════════════════════
function matchesAtom(el, atom) {
  if (!el || el.nodeType !== 1) return false;
  let rest = atom.trim();
  if (!rest) return false;
  const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length) {
    if (rest[0] === '#') {
      const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '.') {
      const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = rest.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/);
      if (!m) return false;
      if (m[2] !== undefined) {
        if (el.getAttribute(m[1]) !== m[2]) return false;
      } else if (!el.hasAttribute(m[1])) {
        return false;
      }
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesChain(el, selector) {
  const parts = selector.trim().split(/\s+/).filter(p => p && p !== '>');
  if (!parts.length || !matchesAtom(el, parts[parts.length - 1])) return false;
  let cur = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (cur && !matchesAtom(cur, parts[i])) cur = cur.parentElement;
    if (!cur) return false;
    cur = cur.parentElement;
  }
  return true;
}

function matchesSelector(el, selectorList) {
  return selectorList.split(',').some(sel => matchesChain(el, sel));
}

function createRichDom() {
  const docListeners = {};

  function makeTextNode(text) {
    return {
      nodeType: 3,
      parentNode: null,
      parentElement: null,
      textContent: String(text || ''),
      remove() {
        if (this.parentElement) this.parentElement.removeChild(this);
      }
    };
  }

  function makeNode(tag = 'div') {
    const attrs = {};
    const listeners = {};
    const children = [];
    let rawHtml = '';
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: '',
      title: '',
      value: '',
      checked: false,
      style: {},
      dataset: {},
      parentElement: null,
      get parentNode() { return el.parentElement; },
      children,
      isConnected: true,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 200, bottom: 100, width: 200, height: 100 }),
      get type() { return attrs.type || ''; },
      set type(v) { attrs.type = String(v || ''); },
      get className() { return attrs.class || ''; },
      set className(v) { attrs.class = String(v || ''); },
      classList: {
        add(...cs) {
          const set = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
          cs.forEach(c => set.add(c));
          attrs.class = Array.from(set).join(' ');
        },
        remove(...cs) {
          const set = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
          cs.forEach(c => set.delete(c));
          attrs.class = Array.from(set).join(' ');
        },
        contains(c) { return (attrs.class || '').split(/\s+/).filter(Boolean).includes(c); },
      },
      get textContent() {
        return children.map(c => c.textContent || '').join('');
      },
      set textContent(v) {
        children.length = 0;
        if (v !== '' && v != null) {
          const t = makeTextNode(String(v));
          t.parentNode = el;
          t.parentElement = el;
          children.push(t);
        }
      },
      get innerHTML() { return rawHtml; },
      set innerHTML(v) { rawHtml = String(v || ''); },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'id') el.id = String(v);
        if (k === 'title') el.title = String(v);
        if (k === 'type') el.type = String(v);
      },
      getAttribute: k => (k in attrs ? attrs[k] : null),
      hasAttribute: k => k in attrs,
      removeAttribute(k) { delete attrs[k]; },
      appendChild(c) {
        if (!c) return c;
        if (c.parentElement && c.parentElement !== el) c.parentElement.removeChild(c);
        c.parentElement = el;
        if (c.nodeType === 3) c.parentNode = el;
        children.push(c);
        return c;
      },
      insertBefore(c, ref) {
        if (!c) return c;
        if (c.parentElement) c.parentElement.removeChild(c);
        c.parentElement = el;
        if (c.nodeType === 3) c.parentNode = el;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) {
          children.splice(idx, 1);
          c.parentElement = null;
          if (c.nodeType === 3) c.parentNode = null;
        }
        return c;
      },
      insertAdjacentElement(pos, node) {
        if (!el.parentElement) return node;
        const p = el.parentElement;
        const idx = p.children.indexOf(el);
        if (pos === 'beforebegin') return p.insertBefore(node, el);
        if (pos === 'afterend') return p.insertBefore(node, p.children[idx + 1] || null);
        return node;
      },
      replaceWith(node) {
        if (!el.parentElement) return;
        const p = el.parentElement;
        p.insertBefore(node, el);
        p.removeChild(el);
      },
      normalize() {
        for (let i = children.length - 1; i > 0; i--) {
          if (children[i].nodeType === 3 && children[i - 1].nodeType === 3) {
            children[i - 1].textContent += children[i].textContent;
            children.splice(i, 1);
          }
        }
      },
      remove() {
        if (el.parentElement) el.parentElement.removeChild(el);
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      closest(sel) {
        let cur = el;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      matches(sel) {
        return matchesSelector(el, sel);
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = node => {
          for (const c of node.children || []) {
            if (c.nodeType === 1) {
              if (matchesSelector(c, sel)) out.push(c);
              walk(c);
            }
          }
        };
        walk(el);
        return out;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
      },
      dispatchEvent(evt = {}) {
        const eventObj = {
          type: evt.type || 'click',
          target: evt.target || el,
          currentTarget: el,
          clientY: evt.clientY ?? 0,
          button: evt.button ?? 0,
          pointerId: evt.pointerId ?? 1,
          preventDefault() { },
          stopPropagation() { },
          ...evt,
        };
        let cur = el;
        while (cur) {
          const map = cur === el ? listeners : (cur._listeners || {});
          (map[eventObj.type] || []).slice().forEach(fn => fn.call(cur, { ...eventObj, currentTarget: cur }));
          cur = cur.parentElement;
        }
        if (el.closest('body')) {
          (docListeners[eventObj.type] || []).slice().forEach(fn => fn.call(document, eventObj));
        }
      },
      _listeners: listeners,
    };
    return el;
  }

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body');
  html.appendChild(head);
  html.appendChild(body);

  const document = {
    readyState: 'complete',
    cookie: '',
    head,
    body,
    documentElement: html,
    createElement: tag => makeNode(tag),
    createTextNode: text => makeTextNode(text),
    getElementById: id => html.querySelector(`#${id}`),
    querySelector: sel => html.querySelector(sel),
    querySelectorAll: sel => html.querySelectorAll(sel),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
    },
    dispatchDocEvent(evt = {}) {
      const eventObj = {
        type: evt.type || 'pointermove',
        target: evt.target || body,
        clientY: evt.clientY ?? 0,
        button: evt.button ?? 0,
        pointerId: evt.pointerId ?? 1,
        preventDefault() { },
        stopPropagation() { },
        ...evt,
      };
      (docListeners[eventObj.type] || []).slice().forEach(fn => fn.call(document, eventObj));
    },
    createTreeWalker(root, whatToShow) {
      const list = [];
      const walk = node => {
        for (const c of node.children || []) {
          if (c.nodeType === 3 && whatToShow === 4) list.push(c);
          else if (c.nodeType === 1) walk(c);
        }
      };
      walk(root);
      let idx = -1;
      return {
        currentNode: null,
        nextNode() {
          idx++;
          this.currentNode = list[idx] || null;
          return this.currentNode;
        }
      };
    },
    makeNode,
  };
  return document;
}

function buildFormInDoc(doc) {
  const form = doc.createElement('form');
  form.className = 'ant-form';
  const item = doc.createElement('div');
  item.className = 'ant-form-item';
  const btn = doc.createElement('button');
  btn.textContent = '重置';
  btn.getBoundingClientRect = () => ({ top: 100, height: 32, bottom: 132 });
  item.appendChild(btn);
  form.appendChild(item);
  doc.body.appendChild(form);
  return form;
}

function buildPlanTableInDoc(doc, { headers, rows, width = '1000px' }) {
  const wrapper = doc.createElement('div');
  wrapper.className = 'ant-table-wrapper';
  const antTable = doc.createElement('div');
  antTable.className = 'ant-table';
  const table = doc.createElement('table');
  table.style.width = width;

  const colgroup = doc.createElement('colgroup');
  headers.forEach(() => {
    const col = doc.createElement('col');
    col.style.width = '120px';
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const thead = doc.createElement('thead');
  thead.className = 'ant-table-thead';
  const headTr = doc.createElement('tr');
  headers.forEach(h => {
    const th = doc.createElement('th');
    th.className = 'ant-table-cell';
    th.textContent = h;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  tbody.className = 'ant-table-tbody';
  const measureRow = doc.createElement('tr');
  measureRow.className = 'ant-table-measure-row';
  headers.forEach(() => {
    measureRow.appendChild(doc.createElement('td'));
  });
  tbody.appendChild(measureRow);

  rows.forEach(r => {
    const tr = doc.createElement('tr');
    tr.className = 'ant-table-row';
    tr.setAttribute('data-row-key', r.key);
    r.cells.forEach(c => {
      const td = doc.createElement('td');
      td.className = 'ant-table-cell';
      td.textContent = c;
      td.getBoundingClientRect = () => ({ top: 200, left: 300, right: 400, bottom: 230, width: 100, height: 30 });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  antTable.appendChild(table);
  wrapper.appendChild(antTable);
  doc.body.appendChild(wrapper);
  return { wrapper, antTable, table, colgroup, headTr, measureRow, tbody };
}

function buildFieldSettingPanelInDoc(doc, items) {
  const panel = doc.createElement('div');
  panel.className = 'task-execute-field-setting';
  const list = doc.createElement('div');
  list.className = 'field-list';

  items.forEach((it, idx) => {
    const row = doc.createElement('div');
    row.setAttribute('data-rbd-draggable-id', it.key);
    row.textContent = it.label;
    const top = 100 + idx * 32;
    row.getBoundingClientRect = () => ({ top, left: 900, width: 180, height: 32, bottom: top + 32 });
    list.appendChild(row);
  });

  const footer = doc.createElement('div');
  const resetBtn = doc.createElement('button');
  resetBtn.className = 'ant-btn';
  const span = doc.createElement('span');
  span.textContent = '恢复默认';
  resetBtn.appendChild(span);
  footer.appendChild(resetBtn);

  panel.appendChild(list);
  panel.appendChild(footer);
  doc.body.appendChild(panel);
  return { panel, list, resetBtn, resetTextSpan: span };
}

function triggerFieldObserver(env, panel) {
  const obs = env.observerInstances.find(o => o.connected && o.target === env.documentBody);
  if (obs) obs.cb([{ target: panel, addedNodes: [panel], removedNodes: [] }]);
}

test('机器人列：默认隐藏时不请求 schedule/page，弹窗复选框未勾选且位于「店铺」之后', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['计划名称', '店铺', '取数执行', '操作'],
    rows: [{ key: '1900000000000000011', cells: ['计划A', '店铺A', '已完成', '详情'] }],
  });
  const env = createEnv({ pathname: TARGET, customDocument: doc });
  env.documentBody = doc.body;
  env.boot();

  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.responseText = JSON.stringify({
    code: '10000',
    bizData: { records: [{ jobUuid: '1900000000000000011', planId: '1900000000000000001', rpaStatus: 5 }] }
  });
  xhr.send('{"dateTime":"2026-11-14"}');
  xhr.fire('load');
  await env.flushAsync();

  const scheduleCalls = env.fetchCalls.filter(c => c.url.includes('/schedule/page'));
  assert.equal(scheduleCalls.length, 0, '默认隐藏时严禁请求 schedule/page');
  assert.equal(tbl.table.querySelectorAll('[data-qsb-bot-col]').length, 0, '表格不应注入机器人列');
  assert.equal(tbl.table.style.width, '1000px');

  const { panel, list } = buildFieldSettingPanelInDoc(doc, [
    { key: 'jobName', label: '计划名称' },
    { key: 'storeName', label: '店铺' },
    { key: 'rpaStatus', label: '取数执行' },
    { key: 'operation', label: '操作' },
  ]);
  triggerFieldObserver(env, panel);
  await env.flushAsync();

  const botItem = list.querySelector('.qsb-field-item[data-qsb-bot-field]');
  assert.ok(botItem, '弹窗内应注入机器人字段项');
  assert.equal(botItem.getAttribute('data-rbd-draggable-id'), null, '不得声明原生 data-rbd-draggable-id');
  const idx = list.children.indexOf(botItem);
  assert.equal(list.children[idx - 1].getAttribute('data-rbd-draggable-id'), 'storeName', '默认位置应紧跟店铺之后');
  assert.equal(botItem.querySelector('input[type="checkbox"]').checked, false, '默认应未勾选');
});

test('机器人列：开启后分页拉取 schedule/page（含 ≥200ms 间隔）并缓存，四处同步插列且支持 planId/jobUuid/19位ID/缺失占位', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['计划名称', '店铺', '取数执行', '操作'],
    rows: [
      { key: '1900000000000000011', cells: ['计划1', '店铺1', '已完成', '详情'] },
      { key: '1900000000000000012', cells: ['计划2', '店铺2', '已完成', '详情'] },
      { key: '1900000000000000013', cells: ['回溯3', '店铺3', '已完成', '详情'] },
      { key: '1900000000000000099', cells: ['已删4', '店铺4', '已完成', '详情'] },
    ],
  });

  const env = createEnv({
    pathname: TARGET,
    customDocument: doc,
    onFetch(url, body) {
      if (!url.includes('/schedule/page')) return null;
      if (body.pageNo === 1) {
        return {
          code: '10000',
          bizData: {
            pages: '2',
            current: '1',
            records: [
              { id: '1900000000000000001', jobUuid: 'other-1', jobType: 1, botName: '飞龙制冷001' },
              { id: '1900000000000000002', jobUuid: 'other-2', jobType: 1, botName: '' },
            ]
          }
        };
      }
      return {
        code: '10000',
        bizData: {
          pages: '2',
          current: '2',
          records: [
            { id: '1900000000000000003', jobUuid: '1900000000000000013', jobType: 2, botName: '飞龙002,飞龙003' },
          ]
        }
      };
    }
  });
  env.documentBody = doc.body;
  env.boot();

  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.responseText = JSON.stringify({
    code: '10000',
    bizData: {
      records: [
        { jobUuid: '1900000000000000011', planId: '1900000000000000001', rpaStatus: 5 },
        { jobUuid: '1900000000000000012', planId: '1900000000000000002', rpaStatus: 5 },
        { jobUuid: '1900000000000000013', rpaStatus: 5 },
        { jobUuid: '1900000000000000099', planId: '1900000000000000099', rpaStatus: 5 },
      ]
    }
  });
  xhr.send('{"dateTime":"2026-11-14"}');
  xhr.fire('load');
  await env.flushAsync();

  const { panel, list } = buildFieldSettingPanelInDoc(doc, [
    { key: 'jobName', label: '计划名称' },
    { key: 'storeName', label: '店铺' },
    { key: 'rpaStatus', label: '取数执行' },
    { key: 'operation', label: '操作' },
  ]);
  triggerFieldObserver(env, panel);
  await env.flushAsync();

  const checkbox = list.querySelector('.qsb-field-item[data-qsb-bot-field] input[type="checkbox"]');
  checkbox.checked = true;
  checkbox.dispatchEvent({ type: 'change' });
  await env.flushAsync();

  const scheduleCalls = env.fetchCalls.filter(c => c.url.includes('/schedule/page'));
  assert.equal(scheduleCalls.length, 2, '应完整拉取 2 页 schedule/page');
  assert.equal(scheduleCalls[0].body.jobType, '', 'jobType 应为空串以覆盖日常与回溯');
  assert.ok(scheduleCalls[1].at - scheduleCalls[0].at >= 200, '分页间隔应 >= 200ms');

  assert.equal(tbl.colgroup.children.length, 5);
  assert.equal(tbl.colgroup.children[2].getAttribute('data-qsb-bot-col'), '1');
  assert.equal(tbl.headTr.children.length, 5);
  assert.equal(tbl.headTr.children[2].textContent, '机器人');
  assert.equal(tbl.measureRow.children.length, 5);
  assert.equal(tbl.measureRow.children[2].getAttribute('data-qsb-bot-col'), '1');
  assert.equal(tbl.table.style.width, '1110px', 'table 宽度应同步增加 110px');

  const dataRows = tbl.tbody.querySelectorAll('tr.ant-table-row');
  assert.equal(dataRows[0].children[2].textContent, '飞龙制冷001');
  assert.equal(dataRows[0].children[2].title, '飞龙制冷001');
  assert.equal(dataRows[1].children[2].textContent, '-', '空 botName 应显示 -');
  assert.equal(dataRows[2].children[2].textContent, '飞龙002,飞龙003', '回溯任务应次选 jobUuid 并如实展示多机器人');
  assert.equal(dataRows[3].children[2].textContent, '-', '已删除计划应显示 -');

  // 关闭再开启 + 切日期：复用内存缓存，不发新 schedule/page 请求
  checkbox.checked = false;
  checkbox.dispatchEvent({ type: 'change' });
  await env.flushAsync();
  assert.equal(tbl.headTr.children.length, 4);
  assert.equal(tbl.table.style.width, '1000px', '关闭后 table 宽度应回退');

  checkbox.checked = true;
  checkbox.dispatchEvent({ type: 'change' });
  await env.flushAsync();
  const xhr2 = new env.FakeXHR();
  xhr2.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr2.responseText = xhr.responseText;
  xhr2.send('{"dateTime":"2026-11-13"}');
  xhr2.fire('load');
  await env.flushAsync();

  const afterCalls = env.fetchCalls.filter(c => c.url.includes('/schedule/page'));
  assert.equal(afterCalls.length, 2, '同生命周期内应复用计划机器人缓存');
});

test('机器人列：手柄指针拖拽调序、不可越过「操作」列，持久化并在隐藏参照列时相邻回退', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['计划名称', '店铺', '取数执行', '操作'],
    rows: [{ key: 'j1', cells: ['计划1', '店铺1', '已完成', '详情'] }],
  });
  const env = createEnv({
    pathname: TARGET,
    customDocument: doc,
    initialLocalStorage: {
      qsb_task_exec_bot_col_v1: JSON.stringify({ visible: true, anchor: { key: 'storeName', side: 'after', label: '店铺' } })
    },
    onFetch: url => url.includes('/schedule/page')
      ? { code: '10000', bizData: { pages: '1', records: [{ id: 'p1', jobUuid: 'j1', botName: 'BotA' }] } }
      : null,
  });
  env.documentBody = doc.body;
  env.boot();
  await env.flushAsync();

  const { panel, list } = buildFieldSettingPanelInDoc(doc, [
    { key: 'jobName', label: '计划名称' },   // top: 100..132, mid: 116
    { key: 'storeName', label: '店铺' },      // top: 132..164, mid: 148
    { key: 'rpaStatus', label: '取数执行' },  // top: 164..196, mid: 180
    { key: 'operation', label: '操作' },      // top: 196..228, mid: 212
  ]);
  triggerFieldObserver(env, panel);
  await env.flushAsync();

  const handle = list.querySelector('.qsb-field-item[data-qsb-bot-field] .qsb-field-handle');
  handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 1 });
  doc.dispatchDocEvent({ type: 'pointermove', clientY: 105, pointerId: 1 });
  assert.ok(doc.querySelector('.qsb-drop-indicator'), '拖拽中应显示插入指示线');
  doc.dispatchDocEvent({ type: 'pointerup', clientY: 105, pointerId: 1 });
  await env.flushAsync();

  assert.equal(doc.querySelector('.qsb-drop-indicator'), null, '松手后应移除指示线');
  assert.equal(tbl.headTr.children[0].textContent, '机器人', '拖到计划名称前应排到第 0 列');
  const saved1 = JSON.parse(env.localStore.qsb_task_exec_bot_col_v1);
  assert.deepEqual(saved1.anchor, { key: 'jobName', side: 'before', label: '计划名称' });

  // 尝试拖到「操作」中线之下：必须被限定在「操作」之前
  handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 2 });
  doc.dispatchDocEvent({ type: 'pointermove', clientY: 260, pointerId: 2 });
  doc.dispatchDocEvent({ type: 'pointerup', clientY: 260, pointerId: 2 });
  await env.flushAsync();

  const thTexts = tbl.headTr.children.map(th => th.textContent);
  assert.deepEqual(thTexts, ['计划名称', '店铺', '取数执行', '机器人', '操作'], '不可越过固定操作列');

  // 新建环境：若「店铺」被原生隐藏，anchor={storeName, after} 应回退到「计划名称」之后（索引 1）
  const doc2 = createRichDom();
  buildFormInDoc(doc2);
  const tbl2 = buildPlanTableInDoc(doc2, {
    headers: ['计划名称', '取数执行', '操作'],
    rows: [{ key: 'j1', cells: ['计划1', '已完成', '详情'] }],
  });
  const env2 = createEnv({
    pathname: TARGET,
    customDocument: doc2,
    initialLocalStorage: {
      qsb_task_exec_bot_col_v1: JSON.stringify({ visible: true, anchor: { key: 'storeName', side: 'after', label: '店铺' } })
    },
  });
  env2.boot();
  await env2.flushAsync();
  assert.deepEqual(tbl2.headTr.children.map(th => th.textContent), ['计划名称', '机器人', '取数执行', '操作']);
});

test('机器人列：点击「恢复默认」重置显隐与默认位置', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['计划名称', '店铺', '取数执行', '操作'],
    rows: [{ key: 'j1', cells: ['计划1', '店铺1', '已完成', '详情'] }],
  });
  const env = createEnv({
    pathname: TARGET,
    customDocument: doc,
    initialLocalStorage: {
      qsb_task_exec_bot_col_v1: JSON.stringify({ visible: true, anchor: { key: 'jobName', side: 'before', label: '计划名称' } })
    },
  });
  env.documentBody = doc.body;
  env.boot();
  await env.flushAsync();
  assert.equal(tbl.headTr.children[0].textContent, '机器人');

  const { panel, list, resetTextSpan } = buildFieldSettingPanelInDoc(doc, [
    { key: 'jobName', label: '计划名称' },
    { key: 'storeName', label: '店铺' },
    { key: 'rpaStatus', label: '取数执行' },
    { key: 'operation', label: '操作' },
  ]);
  triggerFieldObserver(env, panel);
  await env.flushAsync();

  resetTextSpan.dispatchEvent({ type: 'click', target: resetTextSpan });
  await env.flushAsync();

  const saved = JSON.parse(env.localStore.qsb_task_exec_bot_col_v1);
  assert.equal(saved.visible, false);
  assert.equal(saved.anchor.key, 'storeName');
  assert.equal(saved.anchor.side, 'after');
  assert.equal(tbl.table.querySelectorAll('[data-qsb-bot-col]').length, 0);

  const botItem = list.querySelector('.qsb-field-item[data-qsb-bot-field]');
  assert.equal(botItem.querySelector('input[type="checkbox"]').checked, false);
  const idx = list.children.indexOf(botItem);
  assert.equal(list.children[idx - 1].getAttribute('data-rbd-draggable-id'), 'storeName');
});

test('机器人列：插到「店铺」和「取数执行」之前时，店铺筛选高亮与异常色球/Tooltip 仍精准命中目标列', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['计划名称', '店铺', '最近运行开始时间', '最近运行结束时间', '取数执行', '数据入库', '操作'],
    rows: [
      { key: 'job-fail', cells: ['计划A', '旗舰店铺A', '10:00', '10:01', '运行失败', '失败', '详情'] },
      { key: 'job-ok', cells: ['计划B', '普通店铺B', '10:02', '10:03', '已完成', '失败', '详情'] },
    ],
  });
  const env = createEnv({
    pathname: TARGET,
    customDocument: doc,
    initialLocalStorage: {
      qsb_task_exec_bot_col_v1: JSON.stringify({ visible: true, anchor: { key: 'jobName', side: 'before', label: '计划名称' } })
    },
    onFetch: url => url.includes('/schedule/page')
      ? { code: '10000', bizData: { pages: '1', records: [{ id: 'p-fail', jobUuid: 'job-fail', botName: '测试店铺Bot' }] } }
      : null,
  });
  env.boot();

  const xhr = new env.FakeXHR();
  xhr.open('POST', '/frameWorkPortal/opt/qymall/1.0.0/job/record/new');
  xhr.responseText = JSON.stringify({
    code: '10000',
    bizData: {
      records: [
        { jobUuid: 'job-fail', planId: 'p-fail', rpaStatus: 3, lastStartTime: '2026-11-14 10:00:00', lastEndTime: '2026-11-14 10:01:00' },
        { jobUuid: 'job-ok', planId: 'p-ok', rpaStatus: 5, lastStartTime: '2026-11-14 10:02:00', lastEndTime: '2026-11-14 10:03:00' },
      ]
    }
  });
  xhr.send('{"dateTime":"2026-11-14"}');
  xhr.fire('load');
  await env.flushAsync();

  const rows = tbl.tbody.querySelectorAll('tr.ant-table-row');
  // 机器人列在 index 0，店铺在 index 2，取数执行在 index 5，数据入库在 index 6
  assert.equal(tbl.headTr.children[0].textContent, '机器人');
  assert.equal(rows[0].children[0].textContent, '测试店铺Bot');
  assert.equal(rows[0].children[5].getAttribute('data-job-uuid'), 'job-fail', '色球与标记应落在新索引 5 的「取数执行」列');
  assert.ok(rows[0].children[5].querySelector('.qsb-status-bar'), '取数执行列应有异常色球');
  assert.equal(rows[0].children[6].getAttribute('data-job-uuid'), null, '数据入库列不得误挂');

  // 店铺过滤（输入关键字并触发防抖）
  const input = doc.querySelector('.qsb-filter-bar input');
  input.value = '旗舰';
  input.dispatchEvent({ type: 'input' });
  await env.flushAsync();

  assert.equal(rows[0].style.display, '');
  assert.equal(rows[1].style.display, 'none', '不匹配店铺应隐藏');
  assert.ok(rows[0].children[2].querySelector('.qsb-highlight'), '高亮应落在店铺列 index 2');
  assert.equal(rows[0].children[0].querySelector('.qsb-highlight'), null, '机器人列不得被高亮');

  // 悬停取数执行列应弹出 Tooltip
  rows[0].children[5].dispatchEvent({ type: 'mouseover', target: rows[0].children[5] });
  await env.flushAsync();
  assert.ok(doc.querySelector('.qsb-tooltip'), '悬停位移后的取数执行列应正常弹出 Tooltip');
});

test('机器人列：非计划视图不注入，离开页面 teardown 彻底清理节点、监听与缓存', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['任务ID', '执行状态'],
    rows: [{ key: 'x1', cells: ['123', '已完成'] }],
  });
  const env = createEnv({
    pathname: TARGET,
    customDocument: doc,
    initialLocalStorage: {
      qsb_task_exec_bot_col_v1: JSON.stringify({ visible: true, anchor: { key: 'storeName', side: 'after', label: '店铺' } })
    },
  });
  env.documentBody = doc.body;
  env.boot();
  await env.flushAsync();

  assert.equal(tbl.table.querySelectorAll('[data-qsb-bot-col]').length, 0, '非计划视图不得注入机器人列');

  // 切换到计划视图表格并打开设置面板、开启未松手拖拽后离开页面
  tbl.wrapper.remove();
  const planTbl = buildPlanTableInDoc(doc, {
    headers: ['计划名称', '店铺', '取数执行', '操作'],
    rows: [{ key: 'j1', cells: ['计划1', '店铺1', '已完成', '详情'] }],
  });
  const { panel, list } = buildFieldSettingPanelInDoc(doc, [
    { key: 'jobName', label: '计划名称' },
    { key: 'storeName', label: '店铺' },
    { key: 'operation', label: '操作' },
  ]);
  triggerFieldObserver(env, panel);
  const tblObs = env.observerInstances.find(o => o.connected && o.target !== doc.body);
  if (tblObs) tblObs.cb([{ target: planTbl.tbody, addedNodes: [], removedNodes: [] }]);
  await env.flushAsync();

  assert.equal(planTbl.headTr.children[2].textContent, '机器人');
  const beforeMoveCount = (env.docListeners.pointermove || []).length;
  const handle = list.querySelector('.qsb-field-item[data-qsb-bot-field] .qsb-field-handle');
  handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 9 });
  doc.dispatchDocEvent({ type: 'pointermove', clientY: 110, pointerId: 9 });
  assert.ok(doc.querySelector('.qsb-drop-indicator'));
  assert.equal((env.docListeners.pointermove || []).length, beforeMoveCount + 1);

  env.push('/mallQuan/other');
  assert.equal(planTbl.table.querySelectorAll('[data-qsb-bot-col]').length, 0, 'teardown 应清除表格注入列');
  assert.equal(planTbl.table.style.width, '1000px', 'teardown 应恢复 table 宽度');
  assert.equal(doc.querySelectorAll('.qsb-field-item[data-qsb-bot-field]').length, 0, 'teardown 应清除弹窗注入项');
  assert.equal(doc.querySelector('.qsb-drop-indicator'), null, 'teardown 应清除拖拽指示线');
  assert.equal((env.docListeners.pointermove || []).length, beforeMoveCount, 'teardown 应解除拖拽监听');
  assert.equal(env.observerInstances.filter(o => o.connected).length, 0, 'teardown 应断开全部 MutationObserver');
});

test('机器人列（真实页面结构）：识别 data-rbd-droppable-id 弹窗、selection 列保护、最后运行开始时间对齐及兄弟 header 恢复默认', async () => {
  const doc = createRichDom();
  buildFormInDoc(doc);

  // 真实表格包含第 0 列多选框列（ant-table-selection-column）及「最近运行开始时间」表头
  const tbl = buildPlanTableInDoc(doc, {
    headers: ['', '计划名称', '店铺', '最近运行开始时间', '最近运行结束时间', '取数执行', '数据入库', '数据校验', '操作'],
    rows: [{ key: '1900000000000000011', cells: ['', '计划1', '店铺1', '10:00', '10:05', '已完成', '已完成', '已完成', '详情'] }],
    width: '1216px',
  });
  tbl.headTr.children[0].className = 'ant-table-cell ant-table-selection-column';

  const env = createEnv({
    pathname: TARGET,
    customDocument: doc,
    onFetch: url => url.includes('/schedule/page')
      ? { code: '10000', bizData: { pages: '1', records: [{ id: 'p1', jobUuid: '1900000000000000011', botName: '飞龙008' }] } }
      : null,
  });
  env.documentBody = doc.body;
  env.boot();
  await env.flushAsync();

  // 构造真实页面 Antd Popover 结构：起初带 ant-popover-hidden，header 与 droppable list 为兄弟节点
  const popover = doc.createElement('div');
  popover.className = 'ant-popover popover___p5B9I ant-popover-placement-bottomRight ant-popover-hidden';
  const innerContent = doc.createElement('div');
  innerContent.className = 'ant-popover-inner-content';
  const contentWrap = doc.createElement('div');
  contentWrap.className = 'content___fPC8N';

  const header = doc.createElement('div');
  header.className = 'header___UWFdL';
  const titleSpan = doc.createElement('span');
  titleSpan.className = 'title___Lo3KG';
  titleSpan.textContent = '自定义字段';
  const resetLink = doc.createElement('a');
  resetLink.className = 'reset___EXt5g';
  resetLink.textContent = '恢复默认';
  header.appendChild(titleSpan);
  header.appendChild(resetLink);

  const list = doc.createElement('div');
  list.className = 'list___RjHZx';
  list.setAttribute('data-rbd-droppable-id', 'task-execute-field-setting');
  const nativeFields = [
    { key: 'planName', label: '计划名称' },
    { key: 'storeName', label: '店铺' },
    { key: 'startTime', label: '最后运行开始时间' },
    { key: 'endTime', label: '最近运行结束时间' },
    { key: 'rpaStatus', label: '取数执行' },
    { key: 'fileCollectionStatus', label: '采集文件校验' },
    { key: 'dbStatus', label: '数据入库' },
    { key: 'inspectionStatus', label: '数据校验' },
  ];
  nativeFields.forEach((it, idx) => {
    const row = doc.createElement('div');
    row.className = 'item___onDki';
    row.setAttribute('data-rbd-draggable-id', it.key);
    const labelEl = doc.createElement('span');
    labelEl.className = 'label___bDYeU';
    labelEl.textContent = it.label;
    row.appendChild(labelEl);
    const top = 100 + idx * 40;
    row.getBoundingClientRect = () => ({ top, left: 900, width: 220, height: 40, bottom: top + 40 });
    list.appendChild(row);
  });

  contentWrap.appendChild(header);
  contentWrap.appendChild(list);
  innerContent.appendChild(contentWrap);
  popover.appendChild(innerContent);
  doc.body.appendChild(popover);

  const bodyObs = env.observerInstances.find(o => o.connected && o.target === env.documentBody);
  assert.ok(bodyObs, '应已挂载 body MutationObserver');
  // 模拟先挂载、后移除 hidden class 展开弹窗
  popover.classList.remove('ant-popover-hidden');
  bodyObs.cb([{ type: 'attributes', attributeName: 'class', target: popover, addedNodes: [], removedNodes: [] }]);
  await env.flushAsync();

  const botItem = list.querySelector('.qsb-field-item[data-qsb-bot-field]');
  assert.ok(botItem, '真实弹窗结构中必须注入机器人配置项');
  assert.equal(list.children[list.children.indexOf(botItem) - 1].getAttribute('data-rbd-draggable-id'), 'storeName', '默认位置紧跟店铺之后');

  // 勾选启用机器人列，应排到店铺后（index 3，在 selection[0]、计划名称[1]、店铺[2]之后）
  const checkbox = botItem.querySelector('input[type="checkbox"]');
  checkbox.checked = true;
  checkbox.dispatchEvent({ type: 'change' });
  await env.flushAsync();

  assert.equal(tbl.headTr.children[3].textContent, '机器人');
  assert.equal(tbl.tbody.querySelectorAll('tr.ant-table-row')[0].children[3].textContent, '飞龙008');

  // 拖到「计划名称」最前：不得越过第 0 列多选框列，必须落在 index 1
  const handle = botItem.querySelector('.qsb-field-handle');
  handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 3 });
  doc.dispatchDocEvent({ type: 'pointermove', clientY: 105, pointerId: 3 });
  doc.dispatchDocEvent({ type: 'pointerup', clientY: 105, pointerId: 3 });
  await env.flushAsync();
  assert.equal(tbl.headTr.children[0].classList.contains('ant-table-selection-column'), true, '多选框列必须始终在第 0 列');
  assert.equal(tbl.headTr.children[1].textContent, '机器人', '拖到计划名称前应落在 index 1');

  // 拖到「最后运行开始时间」之后（弹窗文案「最后运行开始时间」≠ 表头「最近运行开始时间」）
  handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 4 });
  doc.dispatchDocEvent({ type: 'pointermove', clientY: 210, pointerId: 4 }); // startTime top: 180..220 -> mid: 200 -> after
  doc.dispatchDocEvent({ type: 'pointerup', clientY: 210, pointerId: 4 });
  await env.flushAsync();
  assert.equal(tbl.headTr.children[4].textContent, '机器人', 'startTime 应精准映射到「最近运行开始时间」列之后');

  // 点击兄弟 header 中的「恢复默认」<a> 标签：重置显隐与位置
  resetLink.dispatchEvent({ type: 'click', target: resetLink });
  await env.flushAsync();
  const saved = JSON.parse(env.localStore.qsb_task_exec_bot_col_v1);
  assert.equal(saved.visible, false);
  assert.equal(saved.anchor.key, 'storeName');
  assert.equal(tbl.table.querySelectorAll('[data-qsb-bot-col]').length, 0);
});
