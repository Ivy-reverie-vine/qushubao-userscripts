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

function createEnv({ pathname = '/home', withForm = false, layout = null, table = null, initialStorage = {} } = {}) {
  const logs = [];
  const timers = [];
  const fetchCalls = [];
  const bar = { value: null };
  const windowListeners = {};
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

  const body = makeElement('body');
  const head = makeElement('head');
  const forms = [];

  if (withForm) {
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
      if (sel.includes('.qsb-filter-bar') || sel.includes('.qsb-filter-form-item')) {
        return bar.value ? [bar.value] : [];
      }
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
    fetch: (...args) => {
      fetchCalls.push(args);
      const url = args[0] || '';
      let body = {};
      try {
        body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : (args[1]?.body || {});
      } catch (_) { }

      let jsonRes = { code: '10000', bizData: {} };
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
    windowListeners,
    observerInstances,
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
