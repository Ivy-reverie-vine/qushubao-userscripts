// 内核回归测试：响应钩子分发、页面路由激活/收尾、筛选栏注入。
// 用最小 DOM 桩在 vm 沙箱里跑真实脚本源码，不引入任何依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../qsb-taskexecute-helper.user.js', import.meta.url), 'utf8');
const TARGET = '/mallQuan/taskExecuteManagementV2';

function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: '',
    textContent: '',
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
  return el;
}

function createEnv({ pathname = '/home', withForm = false } = {}) {
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
    const btn = makeElement('button');
    btn.textContent = '重置';
    btn.parentElement = makeElement('div');
    btn.parentElement.insertAdjacentElement = (_pos, node) => {
      if (node && node.className === 'qsb-filter-bar') bar.value = node;
    };
    form.querySelectorAll = sel => (sel === 'button' ? [btn] : []);
    forms.push(form);
  }

  const document = {
    readyState: 'complete',
    cookie: '',
    body,
    head,
    documentElement: makeElement('html'),
    getElementById: () => null,
    createElement: tag => makeElement(tag),
    querySelector: sel => (sel === '.qsb-filter-bar' ? bar.value : null),
    querySelectorAll: sel => (sel === '.ant-form' ? forms : []),
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
