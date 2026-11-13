// ==UserScript==
// @name         取数宝后台助手
// @namespace    https://dep.ai-indeed.com/qushubao-userscripts
// @version      1.3.1
// @description  任务运行记录店铺筛选与异常外显 + 数据中心表字段导出 Excel（单表 / 连接器多 Sheet）与启用表名复制
// @author       青藤
// @icon         http://dep-cloud-fe-ops.ii-ai.tech/favicon.png
// @match        https://dep.ai-indeed.com/*
// @updateURL    https://ivy-reverie-vine.github.io/qushubao-userscripts/qushubao-userscripts.user.js
// @downloadURL  https://ivy-reverie-vine.github.io/qushubao-userscripts/qushubao-userscripts.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // 常量与配置
  // ═══════════════════════════════════════════════════════════════
  const LOG_TAG = '[qushubao-userscripts.user.js]';  // 控制台统一前缀，与脚本文件名一致
  const VERSION = 'v1.3.1';            // 与头部 @version 保持一致，发版时同步修改
  const TASK_EXECUTE_ROUTE = /^\/mallQuan\/taskExecuteManagementV2/;  // 任务执行页路由，按此激活对应页面模块
  const DATA_CENTER_ROUTE = /^\/mallQuan\/dataCenter/;                // 数据中心页路由
  const ROUTE_POLL_MS = 1000;          // 路由变化兜底轮询间隔
  const API_BASE = '/frameWorkPortal/opt/qymall/1.0.0';
  const PRELOAD_CONCURRENCY = 2;      // 后台预加载并发数
  const REQUEST_INTERVAL_MS = 200;     // 请求发起间隔 ≥200ms
  const FILTER_DEBOUNCE_MS = 150;      // 筛选输入防抖
  const HOVER_DEBOUNCE_MS = 150;       // 悬浮防抖
  const TOOLTIP_HIDE_DELAY_MS = 200;   // 鼠标离开后延迟关闭
  const INJECT_RETRY_MS = 1500;        // 注入重试间隔
  const INJECT_MAX_RETRIES = 30;       // 最大注入重试次数

  const RPA_STATUS = { RUNNING: 1, PENDING: 2, FAILED: 3, STOPPED: 4, COMPLETED: 5 };

  const CATEGORY_LABELS = { '1xxx': '客户侧', '2xxx': '平台侧', '3xxx': '流程侧', 'unknown': '未分类' };

  // ═══════════════════════════════════════════════════════════════
  // 错误码分类
  // ═══════════════════════════════════════════════════════════════
  function classifyErrorCode(code) {
    if (!code || code === '0000' || code === '0' || code === 'null' || code === 'None') return null;
    const num = parseInt(code, 10);
    if (num >= 1000 && num < 2000) return '1xxx';
    if (num >= 2000 && num < 3000) return '2xxx';
    if (num >= 3000 && num < 4000) return '3xxx';
    return 'unknown';
  }

  // ═══════════════════════════════════════════════════════════════
  // 全局状态与持久化缓存
  // ═══════════════════════════════════════════════════════════════
  const errorCache = new Map();         // key(date:jobUuid) -> { loading, text, details, counts, lastStartTime, lastEndTime }
  const workCache = new Map();          // workUuid -> Array<workBlock>
  let currentViewDate = '';             // 当前视图查询日期（YYYY-MM-DD）
  let postListBindTimer = null;         // 列表接口返回后的延迟绑定定时器
  const WORK_CACHE_PREFIX = 'qsb_work_';
  const JOB_CACHE_PREFIX = 'qsb_job_';

  function getCurrentDate() {
    if (currentViewDate) return currentViewDate;
    try {
      currentViewDate = extractCurrentDateFromPage();
    } catch (_) { }
    return currentViewDate || '';
  }

  function safeSetSessionItem(key, value) {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(key, value);
    } catch (e) {
      try {
        const qsbKeys = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && (k.startsWith(WORK_CACHE_PREFIX) || k.startsWith(JOB_CACHE_PREFIX))) {
            qsbKeys.push(k);
          }
        }
        for (let i = 0; i < Math.min(20, qsbKeys.length); i++) {
          sessionStorage.removeItem(qsbKeys[i]);
        }
        sessionStorage.setItem(key, value);
      } catch (_) { }
    }
  }

  function getCachedWorkDetails(workUuid) {
    if (!workUuid) return null;
    if (workCache.has(workUuid)) return workCache.get(workUuid);
    try {
      if (typeof sessionStorage !== 'undefined') {
        const val = sessionStorage.getItem(WORK_CACHE_PREFIX + workUuid);
        if (val) {
          const parsed = JSON.parse(val);
          workCache.set(workUuid, parsed);
          return parsed;
        }
      }
    } catch (_) { }
    return null;
  }

  function setCachedWorkDetails(workUuid, details) {
    if (!workUuid || !details) return;
    workCache.set(workUuid, details);
    safeSetSessionItem(WORK_CACHE_PREFIX + workUuid, JSON.stringify(details));
  }

  function makeJobCacheKey(date, jobUuid) {
    return date ? `${date}:${jobUuid}` : String(jobUuid);
  }

  function getJobCache(jobUuid, date) {
    const d = date || getCurrentDate();
    const key = makeJobCacheKey(d, jobUuid);
    if (errorCache.has(key)) return errorCache.get(key);
    if (errorCache.has(jobUuid)) return errorCache.get(jobUuid);

    try {
      if (typeof sessionStorage !== 'undefined') {
        const val = sessionStorage.getItem(JOB_CACHE_PREFIX + key);
        if (val) {
          const data = JSON.parse(val);
          errorCache.set(key, data);
          return data;
        }
      }
    } catch (_) { }
    return null;
  }

  function setJobCache(jobUuid, date, data) {
    const d = date || getCurrentDate();
    const key = makeJobCacheKey(d, jobUuid);
    errorCache.set(key, data);
    if (!data.loading) {
      safeSetSessionItem(JOB_CACHE_PREFIX + key, JSON.stringify(data));
    }
  }

  let preloadQueue = [];
  let preloadRunning = false;
  let preloadAbort = null;              // AbortController
  let currentTooltipEl = null;
  let currentTooltipJobUuid = null;     // 正在显示 tooltip 的 jobUuid
  let currentTooltipAnchor = null;      // 正在显示 tooltip 的锚定元素
  let hoveredStatusTd = null;           // 当前鼠标悬浮的状态单元格
  let hoveredStatusJobUuid = null;      // 当前鼠标悬浮的 jobUuid
  let isMouseOverTooltip = false;       // 当前鼠标是否在 tooltip 浮层内
  let tooltipHideTimer = null;
  let lastInterceptedDateTime = null;   // 从拦截的请求 body 中提取的 dateTime
  let isSelfModifyingDOM = false;       // 标记是否脚本内部正在修改 DOM，彻底防止 Observer 自激死循环
  let interceptedAuthToken = null;      // 运行时从原生请求抓取的 Auth_token / Authorization

  // ═══════════════════════════════════════════════════════════════
  // 智能结构化解析长报错文本（方案 A）
  // ═══════════════════════════════════════════════════════════════
  function parseStructuredError(rawStr, blockName) {
    const raw = String(rawStr || '').trim();
    if (!raw) return { action: blockName || '执行异常', reason: '无详细异常描述', target: '', runTime: '', raw: '' };

    // 1. 尝试提取异常元素名（如：异常元素：拼多多-推广平台-商品推广-自定义列【...）
    let target = '';
    const elemMatch = raw.match(/异常元素[：:]\s*([^\r\n【]+)/);
    if (elemMatch) {
      target = elemMatch[1].trim();
    }

    // 2. 尝试提取运行时间（如：【运行时间36】 或 【运行时间 36s】）
    let runTime = '';
    const timeMatch = raw.match(/【运行时间\s*(\d+s?)】?/);
    if (timeMatch) {
      runTime = timeMatch[1].endsWith('s') ? timeMatch[1] : `${timeMatch[1]}s`;
    }

    // 3. 连接器名称（优先使用流程块 blockName）
    let action = blockName || '';
    if (!action) {
      const actionMatch = raw.match(/\[([^\]]+点击|[^\]]+跳转|[^\]]+输入|[^\]]+滑块|[^\]]+校验|[^\]]+等待)\]/);
      if (actionMatch) {
        action = actionMatch[1];
      }
    }

    // 4. 报错原因解析逻辑：
    // 规则 1: 根据 "#" 拆分为列表, 获取索引 1 作为报错原因
    // 规则 2: 退化，原样拿出来
    let reason = '';
    if (raw.includes('#')) {
      const parts = raw.split('#');
      if (parts.length > 1 && parts[1].trim()) {
        reason = parts[1].trim();
      }
    }
    // 未拆分出有效索引 1 则退化原样输出
    if (!reason) {
      reason = raw;
    }

    return {
      action: action || '流程操作',
      reason,
      target,
      runTime,
      raw
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 请求凭据与上下文工具
  // ═══════════════════════════════════════════════════════════════
  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }

  function getAuthToken() {
    // 1. 优先使用从页面原生 XHR/Fetch 拦截到的 Auth_token / Authorization
    if (interceptedAuthToken) return interceptedAuthToken;

    // 2. 从 Cookie 提取（用户指定的典型 Cookie 名）
    try {
      const cookieToken = getCookie('SHIZAI_DIGITAL_EMPLOYEE_PORTAL_USER_TOKEN')
        || getCookie('Admin-Token')
        || getCookie('token');
      if (cookieToken) return decodeURIComponent(cookieToken).replace(/^Bearer\s+/i, '').trim();
    } catch (_) { /* ignore */ }

    // 3. 回退兜底：localStorage / sessionStorage
    try {
      const raw = localStorage.getItem('Admin-Token')
        || localStorage.getItem('token')
        || sessionStorage.getItem('Admin-Token')
        || sessionStorage.getItem('token');
      if (raw) return raw.replace(/^Bearer\s+/i, '').trim();
    } catch (_) { /* ignore */ }
    return null;
  }

  function apiPost(path, body, signal) {
    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Auth_token'] = `Bearer ${token}`;
    }
    return fetch(API_BASE + path, {
      method: 'POST',
      headers,
      credentials: 'same-origin', // 关键：自动携带同源 Cookie（包含 HttpOnly 的 Session/Token）
      body: JSON.stringify(body),
      signal
    }).then(r => r.json());
  }

  // ═══════════════════════════════════════════════════════════════
  // 注入样式（独立 z-index 层，不污染 Ant Design）
  // ═══════════════════════════════════════════════════════════════
  function injectStyles() {
    if (document.getElementById('qsb-enhancer-style')) return;
    const style = document.createElement('style');
    style.id = 'qsb-enhancer-style';
    style.textContent = `
      .qsb-filter-bar {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-left: 12px;
        vertical-align: middle;
        position: relative;   /* 供 alignFilterBar() 用 top 做垂直微调 */
      }
      /* 作为 ant-form-item 包装时的样式，保证与左侧重置按钮严格水平对齐 */
      .ant-form-item.qsb-filter-form-item {
        margin-bottom: 0 !important;
        vertical-align: middle !important;
        display: inline-block !important;
      }
      .ant-form-item.qsb-filter-form-item .ant-form-item-control-input {
        min-height: 32px !important;
        display: flex;
        align-items: center;
      }
      .qsb-filter-bar input {
        width: 200px; height: 32px;
        padding: 4px 28px 4px 11px;
        border: 1px solid #d9d9d9;
        border-radius: 4px;
        font-size: 14px;
        line-height: 1.5;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.2s;
      }
      .qsb-filter-bar input:focus {
        border-color: #1890ff;
        box-shadow: 0 0 0 2px rgba(24,144,255,0.2);
      }
      .qsb-filter-bar .qsb-clear-btn {
        position: absolute; right: 6px; top: 50%;
        transform: translateY(-50%);
        cursor: pointer; color: #bbb;
        font-size: 14px; line-height: 1; user-select: none;
      }
      .qsb-filter-bar .qsb-clear-btn:hover { color: #999; }
      .qsb-filter-bar .qsb-input-wrap { position: relative; display: inline-block; }
      .qsb-filter-bar .qsb-count-badge {
        font-size: 12px; color: #666; white-space: nowrap;
      }
      .qsb-highlight {
        background: #fffb8f; padding: 0 1px; border-radius: 2px;
      }

      /* Tooltip 浮层 */
      .qsb-tooltip {
        position: fixed; z-index: 99999;
        max-width: 620px; min-width: 360px;
        background: #fff;
        border: 1px solid #e8e8e8;
        border-radius: 6px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.15);
        padding: 12px 16px;
        font-size: 13px; line-height: 1.6; color: #333;
        pointer-events: auto;
        animation: qsb-fade-in 0.15s ease;
      }
      @keyframes qsb-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .qsb-tooltip-header {
        font-weight: 600; margin-bottom: 8px;
        padding-bottom: 6px; border-bottom: 1px solid #f0f0f0;
        font-size: 13px; color: #333;
      }
      /* 内容防御滚动区 */
      .qsb-tooltip-body {
        max-height: 400px;
        overflow-y: auto;
        padding-right: 4px;
      }
      .qsb-tooltip-body::-webkit-scrollbar {
        width: 5px;
      }
      .qsb-tooltip-body::-webkit-scrollbar-thumb {
        background: #d9d9d9;
        border-radius: 4px;
      }
      .qsb-tooltip-body::-webkit-scrollbar-thumb:hover {
        background: #bfbfbf;
      }
      .qsb-tooltip-cat {
        display: inline-block; padding: 1px 6px; margin: 0 3px;
        border-radius: 3px; font-size: 12px; font-weight: 500;
      }
      .qsb-cat-1xxx { background: #fff2e8; color: #d4380d; }
      .qsb-cat-2xxx { background: #e6f7ff; color: #096dd9; }
      .qsb-cat-3xxx { background: #fff7e6; color: #d48806; }
      .qsb-cat-unknown { background: #f5f5f5; color: #8c8c8c; }

      /* 卡片式结构化报错明细 */
      .qsb-tooltip-card {
        margin: 6px 0;
        padding: 8px 10px;
        background: #fafafa;
        border: 1px solid #f0f0f0;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.5;
        color: #444;
      }
      .qsb-card-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }
      .qsb-card-shop {
        color: #1890ff;
        font-weight: 600;
      }
      .qsb-card-row {
        margin: 2px 0;
        word-break: break-all;
      }
      .qsb-card-label {
        color: #8c8c8c;
        margin-right: 4px;
      }
      .qsb-card-val-elem {
        color: #cf1322;
        background: #fff1f0;
        padding: 1px 4px;
        border-radius: 2px;
        font-family: monospace;
      }
      .qsb-copy-btn {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 1px 6px;
        font-size: 11px;
        color: #1890ff;
        background: #fff;
        border: 1px solid #91d5ff;
        border-radius: 3px;
        cursor: pointer;
        user-select: none;
        transition: all 0.2s;
      }
      .qsb-copy-btn:hover {
        background: #e6f7ff;
        border-color: #40a9ff;
      }
      .qsb-copy-btn.copied {
        color: #52c41a;
        border-color: #b7eb8f;
        background: #f6ffed;
      }
      .qsb-tooltip-loading { color: #999; font-style: italic; }

      /* 状态圆球数字徽标 */
      .qsb-status-bar {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: 6px;
        /* 用基线对齐：圆球里的数字与"运行失败"这类状态文字坐在同一条基线上。
           之前是 vertical-align: middle —— 它对齐的是"基线 + 半个 x-height"，
           比文字视觉中心低约半个字高，圆球看着就往下掉了一截。 */
        vertical-align: baseline;
      }
      .qsb-bar-seg {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 4px;
        border-radius: 9px;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        box-sizing: border-box;
        transition: transform 0.15s ease;
      }
      .qsb-bar-seg:hover {
        transform: scale(1.15);
      }
      .qsb-seg-1xxx { background: #ff7875; color: #fff; box-shadow: 0 1px 2px rgba(245,34,45,0.25); }
      .qsb-seg-2xxx { background: #40a9ff; color: #fff; box-shadow: 0 1px 2px rgba(24,144,255,0.25); }
      .qsb-seg-3xxx { background: #faad14; color: #fff; box-shadow: 0 1px 2px rgba(250,173,20,0.25); }
      .qsb-seg-unknown { background: #8c8c8c; color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }

      /* 数据中心：导出Excel 列（收窄 ant-btn-link 的默认内边距，别把列撑宽） */
      .qsb-export-btn {
        padding: 0 4px !important;
        height: auto !important;
        font-size: 13px;
      }
      .qsb-export-btn[disabled] { opacity: 0.55; cursor: default; }
      /* 96px 与注入的 <col> 宽度保持一致；colgroup 缺失时靠这条兜底 */
      .ant-table-expanded-row th[data-qsb-export],
      .ant-table-expanded-row td[data-qsb-export] {
        width: 96px;
        white-space: nowrap;
        padding-left: 8px;
        padding-right: 8px;
      }

      /* 数据中心：表头「导出Excel」做成可点的文字入口（导出本连接器全部启用表） */
      .qsb-export-all {
        color: #1890ff;
        cursor: pointer;
        user-select: none;
      }
      .qsb-export-all:hover { color: #40a9ff; text-decoration: underline; }
      .qsb-export-all[data-qsb-busy='1'] {
        color: #8c8c8c;
        cursor: default;
        text-decoration: none;
      }

      /* 数据中心：表头「复制启用表名」按钮（复用 .qsb-copy-btn 的外观，只压尺寸） */
      .qsb-copy-btn.qsb-copy-btn--th {
        margin-left: 6px;
        padding: 0 5px;
        font-size: 11px;
        line-height: 16px;
        font-weight: 400;
        vertical-align: 1px;
        white-space: nowrap;
      }
      /* 剪贴板被拒时的兜底面板：只展示、不自动写剪贴板 */
      .qsb-copy-panel {
        position: fixed; z-index: 100001;
        top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 520px; max-width: 90vw;
        background: #fff; color: #333;
        border: 1px solid #e8e8e8; border-radius: 6px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.2);
        padding: 14px 16px;
        font-size: 13px; line-height: 1.6;
      }
      .qsb-copy-panel-title { font-weight: 600; margin-bottom: 8px; }
      .qsb-copy-panel textarea {
        width: 100%; height: 260px; margin-bottom: 10px;
        padding: 8px; box-sizing: border-box;
        border: 1px solid #d9d9d9; border-radius: 4px;
        font-family: Consolas, Menlo, monospace; font-size: 12px; line-height: 1.6;
        resize: vertical;
      }
      .qsb-copy-panel-foot {
        display: flex; align-items: center; justify-content: space-between;
      }
      .qsb-copy-panel-count { color: #8c8c8c; font-size: 12px; }
    `;
    document.head.appendChild(style);
  }

  // ═══════════════════════════════════════════════════════════════
  // 功能 1：店铺名称筛选
  // ═══════════════════════════════════════════════════════════════
  let filterInput = null;
  let countBadge = null;
  let filterAnchorBtn = null;      // 同行的原生控件，垂直对齐的唯一可信基准
  let alignHooked = false;

  /** 顶栏 ant-form 里的"重置"按钮：既是注入位置，也是对齐全高/中心的基准 */
  function findAnchorButton() {
    for (const form of document.querySelectorAll('.ant-form')) {
      for (const btn of form.querySelectorAll('button')) {
        const text = btn.textContent.trim().replace(/\s+/g, '');
        if (text === '重置') return btn;
      }
    }
    return null;
  }

  /**
   * 把筛选栏对齐到同行原生控件。
   * 站点的控件高度来自主题（实测 36px），脚本里写死 32px 就比同行矮一截；
   * 自建的 .ant-form-item 外壳又脱离了 antd 的 flex 行布局，垂直居中对不上，
   * 于是筛选框比左边一排控件低十几像素、且更矮 —— 看着就是"没平行"。
   * 这里不猜像素：以基准控件的实测矩形为准，先对齐高度，再补偿中心线偏差。
   * 每次都是"归零后重新量"，所以反复调用不会累积漂移。
   */
  function alignFilterBar() {
    const bar = document.querySelector('.qsb-filter-bar');
    if (!bar || !filterInput) return;
    const ref = (filterAnchorBtn && filterAnchorBtn.isConnected)
      ? filterAnchorBtn
      : (filterAnchorBtn = findAnchorButton());
    if (!ref) return;
    // 没有布局信息（测试桩 / 隐藏容器）时直接跳过，别把异常抛到定时器里
    if (typeof ref.getBoundingClientRect !== 'function'
      || typeof filterInput.getBoundingClientRect !== 'function') return;

    const refRect = ref.getBoundingClientRect();
    if (!refRect.height) return;                 // 还没布局，等下一次调度

    const h = Math.round(refRect.height);
    if (filterInput.style.height !== h + 'px') filterInput.style.height = h + 'px';

    // 先把偏移归零再量，量到的是"原始位置"：算多少次结果都一样，不会累积漂移
    bar.dataset.qsbOffsetY = '0';
    bar.style.top = '0px';
    const inputRect = filterInput.getBoundingClientRect();
    const dy = (refRect.top + refRect.height / 2) - (inputRect.top + inputRect.height / 2);
    const next = Math.round(Math.max(-40, Math.min(40, dy)) * 10) / 10;
    bar.dataset.qsbOffsetY = String(next);
    bar.style.top = next + 'px';
  }

  function onFilterBarResize() {
    alignFilterBar();
  }

  /** 注入当帧、字体/主题重排后各校一次；窗口尺寸变化再校一次（监听只装一遍） */
  function scheduleAlign() {
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 0);
    raf(() => alignFilterBar());
    setTimeout(alignFilterBar, 300);
    setTimeout(alignFilterBar, 1000);
    if (alignHooked) return;
    alignHooked = true;
    window.addEventListener('resize', onFilterBarResize, { passive: true });
  }

  function injectFilterBar() {
    if (document.querySelector('.qsb-filter-bar')) return true;

    // 在顶部 ant-form 的"重置"按钮右侧注入
    const anchorBtn = findAnchorButton();
    if (!anchorBtn) return false;

    const container = document.createElement('span');
    container.className = 'qsb-filter-bar';

    const inputWrap = document.createElement('span');
    inputWrap.className = 'qsb-input-wrap';

    filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = '过滤店铺名称...';

    const clearBtn = document.createElement('span');
    clearBtn.className = 'qsb-clear-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = '清空筛选';
    clearBtn.style.display = 'none';
    clearBtn.addEventListener('click', () => {
      filterInput.value = '';
      clearBtn.style.display = 'none';
      applyFilter('');
    });

    inputWrap.appendChild(filterInput);
    inputWrap.appendChild(clearBtn);

    countBadge = document.createElement('span');
    countBadge.className = 'qsb-count-badge';

    container.appendChild(inputWrap);
    container.appendChild(countBadge);

    // 挂载：若在 ant-form-item 内部，则包裹成 ant-form-item 插入保持平行对齐；若在行内容器则直接插入
    const formItem = anchorBtn.closest('.ant-form-item');
    if (formItem) {
      const wrapperItem = document.createElement('div');
      wrapperItem.className = 'ant-form-item qsb-filter-form-item';
      const itemControl = document.createElement('div');
      itemControl.className = 'ant-form-item-control';
      const itemInput = document.createElement('div');
      itemInput.className = 'ant-form-item-control-input';
      const itemInputContent = document.createElement('div');
      itemInputContent.className = 'ant-form-item-control-input-content';

      itemInputContent.appendChild(container);
      itemInput.appendChild(itemInputContent);
      itemControl.appendChild(itemInput);
      wrapperItem.appendChild(itemControl);

      formItem.insertAdjacentElement('afterend', wrapperItem);
    } else {
      anchorBtn.parentElement.insertAdjacentElement('afterend', container);
    }

    // 挂上去之后再拿实测矩形校正高度与中心线（写死的 CSS 尺寸在换主题后必然偏）
    filterAnchorBtn = anchorBtn;
    scheduleAlign();

    // 监听输入（150ms 防抖）
    let debounceTimer = null;
    filterInput.addEventListener('input', () => {
      clearBtn.style.display = filterInput.value ? 'block' : 'none';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => applyFilter(filterInput.value), FILTER_DEBOUNCE_MS);
    });

    return true;
  }

  /** 查找主表格（排除弹窗 ant-modal 内的详情表格）每行的店铺名称列索引 */
  let _storeColIdx = -1;
  function getMainTable() {
    // 优先选择不在 modal 弹窗中的 table
    const tables = document.querySelectorAll('.ant-table');
    for (const tbl of tables) {
      if (!tbl.closest('.ant-modal') && !tbl.closest('.ant-drawer')) {
        return tbl;
      }
    }
    return document.querySelector('.ant-table');
  }

  function findStoreColumnIndex() {
    const mainTable = getMainTable();
    if (!mainTable) return 2;

    const ths = mainTable.querySelectorAll('.ant-table-thead th');
    for (let i = 0; i < ths.length; i++) {
      const text = ths[i].textContent.trim();
      if (text.includes('店铺') || text.includes('storeName') || text === '关联店铺') {
        _storeColIdx = i;
        return i;
      }
    }
    _storeColIdx = 2;
    return 2;
  }

  function applyFilter(keyword) {
    const mainTable = getMainTable();
    if (!mainTable) return;

    // 只过滤主表格的行，绝不干扰弹窗中的表格（.ant-modal 等）
    const rows = mainTable.querySelectorAll('.ant-table-tbody tr.ant-table-row');
    if (!rows.length) return;

    const colIdx = _storeColIdx >= 0 ? _storeColIdx : findStoreColumnIndex();
    const kw = keyword.trim().toLowerCase();
    let visible = 0;
    const total = rows.length;

    isSelfModifyingDOM = true;
    try {
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        const storeCell = cells[colIdx] || cells[2];
        if (!storeCell) { row.style.display = ''; visible++; return; }

        if (!kw) {
          if (row.style.display !== '') row.style.display = '';
          visible++;
          removeHighlight(storeCell);
          return;
        }

        const text = storeCell.textContent.toLowerCase();
        if (text.includes(kw)) {
          if (row.style.display !== '') row.style.display = '';
          visible++;
          highlightText(storeCell, keyword.trim());
        } else {
          if (row.style.display !== 'none') row.style.display = 'none';
          removeHighlight(storeCell);
        }
      });

      if (countBadge) {
        countBadge.textContent = kw ? `显示 ${visible} / ${total} 条` : '';
      }
    } finally {
      setTimeout(() => { isSelfModifyingDOM = false; }, 0);
    }
  }

  function highlightText(cell, keyword) {
    removeHighlight(cell);
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const kwLower = keyword.toLowerCase();
    for (const node of nodes) {
      const text = node.textContent;
      const idx = text.toLowerCase().indexOf(kwLower);
      if (idx === -1) continue;

      const before = text.substring(0, idx);
      const match = text.substring(idx, idx + keyword.length);
      const after = text.substring(idx + keyword.length);

      const span = document.createElement('span');
      span.className = 'qsb-highlight';
      span.textContent = match;

      const parent = node.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    }
  }

  function removeHighlight(cell) {
    cell.querySelectorAll('.qsb-highlight').forEach(el => {
      el.replaceWith(document.createTextNode(el.textContent));
    });
    cell.normalize();
  }

  // ═══════════════════════════════════════════════════════════════
  // 功能 2：静默预加载 + 报错外显
  // ═══════════════════════════════════════════════════════════════

  // ── 响应钩子注册表：按 URL 声明要监听的接口，新增页面时只登记、不改拦截器 ──
  const responseHooks = [];   // { match: string | RegExp, onRequest?(body, url), onResponse?(data, url) }

  function onResponse(match, hooks) {
    responseHooks.push({ match, ...hooks });
  }

  function hooksForUrl(url) {
    if (!url) return [];
    return responseHooks.filter(h => (typeof h.match === 'string' ? url.includes(h.match) : h.match.test(url)));
  }

  // ── 拦截 XHR 和 fetch，把命中的请求分发给注册的钩子 ──
  function setupResponseInterceptor() {
    // --- XHR ---
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const origXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this._qsbUrl = url;
      return origXHROpen.call(this, method, url, ...args);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      const hLower = header.toLowerCase();
      if ((hLower === 'auth_token' || hLower === 'authorization') && value) {
        interceptedAuthToken = String(value).replace(/^Bearer\s+/i, '').trim();
      }
      return origXHRSetHeader.call(this, header, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
      const hooks = hooksForUrl(this._qsbUrl);
      if (hooks.length) {
        const reqContext = {};
        hooks.forEach(h => { try { h.onRequest?.(body, this._qsbUrl, reqContext); } catch (_) { } });
        this.addEventListener('load', function () {
          let data = null;
          try { data = JSON.parse(this.responseText); } catch (_) { return; }
          hooks.forEach(h => { try { h.onResponse?.(data, this._qsbUrl, reqContext); } catch (_) { } });
        });
      }
      return origXHRSend.call(this, body);
    };

    // --- fetch ---
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');

      // 尝试从 fetch 的 headers 提取 token
      if (init && init.headers) {
        try {
          let hToken = null;
          if (init.headers instanceof Headers) {
            hToken = init.headers.get('auth_token') || init.headers.get('authorization');
          } else if (typeof init.headers === 'object') {
            hToken = init.headers['Auth_token'] || init.headers['auth_token'] || init.headers['Authorization'] || init.headers['authorization'];
          }
          if (hToken) {
            interceptedAuthToken = String(hToken).replace(/^Bearer\s+/i, '').trim();
          }
        } catch (_) { }
      }

      const reqContext = {};
      const hooks = hooksForUrl(url);
      if (hooks.length) {
        hooks.forEach(h => { try { h.onRequest?.(init?.body, url, reqContext); } catch (_) { } });
      }
      const p = origFetch.apply(this, arguments);
      if (hooks.length) {
        p.then(response => {
          response.clone().json()
            .then(data => hooks.forEach(h => { try { h.onResponse?.(data, url, reqContext); } catch (_) { } }))
            .catch(() => { });
          return response;
        });
      }
      return p;
    };
  }

  function tryExtractDateFromBody(body, url, reqContext) {
    try {
      if (!body) return;
      let parsed = null;
      if (typeof body === 'string') {
        parsed = JSON.parse(body);
      } else if (body instanceof FormData) {
        const dt = body.get('dateTime');
        if (dt) {
          lastInterceptedDateTime = String(dt).trim();
          if (reqContext) reqContext.dateTime = lastInterceptedDateTime;
        }
        return;
      } else if (typeof body === 'object') {
        parsed = body;
      }
      if (parsed && parsed.dateTime) {
        const dt = String(parsed.dateTime).trim();
        lastInterceptedDateTime = dt;
        if (reqContext) reqContext.dateTime = dt;
      }
    } catch (_) { }
  }

  function onListResponseReceived(data, url, reqContext) {
    if (!data || data.code !== '10000') return;
    const biz = data.bizData;
    if (!biz) return;
    const records = biz.records || [];
    if (!Array.isArray(records) || !records.length) return;

    // 清理旧运行队列与浮层（不清除已有正确缓存）
    resetPreloadState();

    // 确定查询日期：
    // 1. 优先使用当前请求上下文中的 dateTime
    // 2. 其次使用最近拦截到的 dateTime
    // 3. 再次从返回记录的 lastStartTime/lastEndTime 中推断（格式如 2026-11-08 09:16:18）
    // 4. 再次从页面 DOM 中提取
    let dateTime = (reqContext && reqContext.dateTime) || lastInterceptedDateTime;
    if (!dateTime) {
      for (const r of records) {
        const timeStr = r.lastStartTime || r.lastEndTime;
        if (timeStr && /^\d{4}-\d{2}-\d{2}/.test(timeStr)) {
          dateTime = timeStr.slice(0, 10);
          break;
        }
      }
    }
    if (!dateTime) {
      dateTime = getCurrentDate();
    }
    currentViewDate = dateTime;

    // 提取需预加载的非完成任务（rpaStatus !== 5）
    const targetJobs = records.filter(r => r.jobUuid && r.rpaStatus !== RPA_STATUS.COMPLETED);

    // 加入预加载队列（若已有该日期与运行周期的有效缓存则跳过网络请求）
    for (const job of targetJobs) {
      const cached = getJobCache(job.jobUuid, dateTime);
      const isSameRun = cached && !cached.loading &&
        (cached.lastStartTime === job.lastStartTime) &&
        (cached.lastEndTime === job.lastEndTime);

      if (isSameRun) continue;

      setJobCache(job.jobUuid, dateTime, {
        loading: true,
        text: '加载中...',
        details: [],
        counts: {},
        lastStartTime: job.lastStartTime,
        lastEndTime: job.lastEndTime
      });
      preloadQueue.push({
        jobUuid: job.jobUuid,
        dateTime,
        lastStartTime: job.lastStartTime,
        lastEndTime: job.lastEndTime
      });
    }

    if (preloadQueue.length) startPreloadWorker();

    // 等 DOM 更新后重新绑定（先清理旧行标记，防止新旧行复用遗留脏数据）
    clearTimeout(postListBindTimer);
    postListBindTimer = setTimeout(() => {
      postListBindTimer = null;
      if (!isTaskExecuteActive()) return;
      _storeColIdx = -1; // 重新探测列索引
      findStoreColumnIndex();
      if (filterInput && filterInput.value) applyFilter(filterInput.value);
      attachTooltipListeners(true);
    }, 600);
  }

  function extractCurrentDateFromPage() {
    // 从日期选择器读取
    for (const input of document.querySelectorAll('.ant-picker input, .ant-calendar-picker input, input[type="text"]')) {
      const val = (input.value || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    }
    // 从激活的日期 tab 读取
    for (const tab of document.querySelectorAll('.ant-tabs-tab-active, .ant-radio-button-wrapper-checked')) {
      const m = tab.textContent.match(/(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
    // 默认今天（北京时间）
    const now = new Date();
    const bjMs = now.getTime() + (now.getTimezoneOffset() + 480) * 60000;
    return new Date(bjMs).toISOString().slice(0, 10);
  }

  function resetPreloadState(clearCache = false) {
    if (preloadAbort) { preloadAbort.abort(); preloadAbort = null; }
    preloadQueue = [];
    preloadRunning = false;
    if (clearCache) {
      errorCache.clear();
    }
    hideTooltip();
  }

  async function startPreloadWorker() {
    if (preloadRunning) return;
    preloadRunning = true;
    preloadAbort = new AbortController();

    const workers = [];
    for (let i = 0; i < PRELOAD_CONCURRENCY; i++) {
      workers.push(runWorker(preloadAbort.signal));
    }
    await Promise.allSettled(workers);
    preloadRunning = false;
  }

  async function runWorker(signal) {
    while (preloadQueue.length > 0) {
      if (signal.aborted) return;
      const task = preloadQueue.shift();
      if (!task) break;
      try {
        await preloadJobErrors(task.jobUuid, task.dateTime, signal, task.lastStartTime, task.lastEndTime);
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.warn(LOG_TAG, '预加载失败:', task.jobUuid, e.message);
        setJobCache(task.jobUuid, task.dateTime, {
          loading: false,
          text: '加载失败',
          details: [],
          counts: {},
          lastStartTime: task.lastStartTime,
          lastEndTime: task.lastEndTime
        });
      }
      // 请求间隔
      if (preloadQueue.length > 0) await sleep(REQUEST_INTERVAL_MS);
    }
  }

  async function preloadJobErrors(jobUuid, dateTime, signal, lastStartTime, lastEndTime) {
    // ── L2: 获取执行订单 ──
    const l2Res = await apiPost('/job/record/detail/new', {
      pageNo: 1, pageSize: 50, jobUuid, dateTime
    }, signal);

    if (!l2Res || l2Res.code !== '10000') {
      throw new Error('L2 失败');
    }

    const l2Records = l2Res.bizData?.records || [];
    if (!l2Records.length) {
      finalize(jobUuid, '无执行记录', [], {}, dateTime, lastStartTime, lastEndTime);
      return;
    }

    // 取最新一条订单
    const exeOrderUuid = l2Records[0]?.exeOrderUuid;
    if (!exeOrderUuid) {
      finalize(jobUuid, '无订单ID', [], {}, dateTime, lastStartTime, lastEndTime);
      return;
    }

    await sleep(REQUEST_INTERVAL_MS);
    if (signal.aborted) return;

    // ── L3: 获取工作项列表（bizData 是数组） ──
    const l3Res = await apiPost('/job/record/work/list', { exeOrderUuid }, signal);
    if (!l3Res || l3Res.code !== '10000') {
      throw new Error('L3 失败');
    }

    const works = l3Res.bizData;
    const failedWorks = Array.isArray(works)
      ? works.filter(w => w.rpaStatus === RPA_STATUS.FAILED && w.workUuid)
      : [];

    if (!failedWorks.length) {
      finalize(jobUuid, '无失败工作项', [], { '1xxx': 0, '2xxx': 0, '3xxx': 0, 'unknown': 0 }, dateTime, lastStartTime, lastEndTime);
      return;
    }

    // ── L4: 逐个失败工作项查流程块详情（优先读取 workUuid 持久缓存） ──
    const allDetails = [];
    const counts = { '1xxx': 0, '2xxx': 0, '3xxx': 0, 'unknown': 0 };

    for (const work of failedWorks) {
      if (signal.aborted) return;

      const cachedBlocks = getCachedWorkDetails(work.workUuid);
      if (cachedBlocks) {
        for (const block of cachedBlocks) {
          counts[block.category] = (counts[block.category] || 0) + 1;
          allDetails.push(block);
        }
        continue;
      }

      await sleep(REQUEST_INTERVAL_MS);

      try {
        const l4Res = await apiPost('/work/result/new', {
          workUuid: work.workUuid, isProcess: 'N', status: 0
        }, signal);

        const workBlocks = [];
        if (l4Res?.code === '10000' && l4Res.bizData) {
          const blocks = l4Res.bizData.output?.result || [];
          for (const block of blocks) {
            const errCode = String(block.errCode || '').trim();
            const cat = classifyErrorCode(errCode);
            if (!cat) continue; // 0000 / 空 = 成功块，跳过

            counts[cat]++;
            const rawMsg = String(block.errMessage || block.description || '').trim();
            const structured = parseStructuredError(rawMsg, block.blockName);
            const item = {
              errCode,
              shopName: String(block.shopName || '-'),
              category: cat,
              action: structured.action,
              reason: structured.reason,
              target: structured.target,
              runTime: structured.runTime,
              rawMsg: structured.raw
            };
            workBlocks.push(item);
            allDetails.push(item);
          }
        }
        setCachedWorkDetails(work.workUuid, workBlocks);
      } catch (e) {
        if (e.name === 'AbortError') return;
        // 单条 L4 失败不中断
      }
    }

    const text = `[1xxx: ${counts['1xxx']}个, 2xxx: ${counts['2xxx']}个, 3xxx: ${counts['3xxx']}个, unknown: ${counts['unknown']}个]`;
    finalize(jobUuid, text, allDetails, counts, dateTime, lastStartTime, lastEndTime);
    updateRowVisualBar(jobUuid, dateTime);
  }

  function finalize(jobUuid, text, details, counts, dateTime, lastStartTime, lastEndTime) {
    const d = dateTime || currentViewDate;
    setJobCache(jobUuid, d, {
      loading: false,
      text,
      details,
      counts,
      lastStartTime,
      lastEndTime
    });
    // 如果当前 tooltip 正在显示此 job，仅当鼠标仍在锚点或浮层上时才就地刷新；若鼠标已移开则关闭
    if (currentTooltipJobUuid === jobUuid && currentTooltipAnchor) {
      if (hoveredStatusTd === currentTooltipAnchor || isMouseOverTooltip) {
        showTooltip(currentTooltipAnchor, jobUuid, d);
      } else {
        hideTooltip();
      }
    }
    updateRowVisualBar(jobUuid, d);
  }

  // ═══════════════════════════════════════════════════════════════
  // 外显胶囊色条（无需 Hover 即可一眼看清错误结构）
  // ═══════════════════════════════════════════════════════════════
  function updateRowVisualBar(jobUuid, date) {
    const mainTable = getMainTable();
    if (!mainTable) return;
    // 优先通过 data-row-key 或已缓存的 jobUuid 快速单点定位行，避免 O(N) 扫全表
    let targetRow = mainTable.querySelector(`.ant-table-tbody tr[data-row-key="${CSS.escape ? CSS.escape(jobUuid) : jobUuid}"]`);
    if (!targetRow) {
      const rows = mainTable.querySelectorAll('.ant-table-tbody tr.ant-table-row');
      for (const row of rows) {
        if (extractJobUuid(row) === jobUuid) {
          targetRow = row;
          break;
        }
      }
    }
    if (targetRow) {
      renderBarInRow(targetRow, jobUuid, date);
    }
  }

  // ── 状态列定位 ────────────────────────────────────────────────
  // 状态与异常只属于「取数执行」一列。旧实现是"哪个单元格的文本含'失败'就认哪个"，
  // 而「数据入库」「数据校验」列同样会出现"失败"，于是"取数执行=已完成"的行
  // 会把「数据入库」误判成状态格：鼠标停上去冒浮层、色球也可能挂错列。
  // 悬停时每次 mouseover 都会问一次，按表格元素缓存（表格被重建则自动失效）
  let _statusColCache = { table: null, idx: -1 };

  function findStatusColumnIndex() {
    const mainTable = getMainTable();
    if (!mainTable) return -1;
    if (_statusColCache.table === mainTable) return _statusColCache.idx;

    const ths = mainTable.querySelectorAll('.ant-table-thead th');
    let idx = -1;
    for (let i = 0; i < ths.length; i++) {
      if (ths[i].textContent.replace(/\s+/g, '').includes('取数执行')) { idx = i; break; }
    }
    if (idx < 0) return -1;              // 表头还没渲染出来：不缓存，下次再找
    _statusColCache = { table: mainTable, idx };
    return idx;
  }

  const STATUS_TEXT_HINTS = ['运行失败', '运行中', '待运行', '失败', '停止'];

  /** 行内的状态格；「已完成」返回 null（没有异常可看，也不挂浮层） */
  function getStatusCell(row) {
    if (!row) return null;
    const cells = row.querySelectorAll('td');
    const idx = findStatusColumnIndex();

    if (idx >= 0) {
      const td = cells[idx];
      if (!td) return null;
      const text = td.textContent.replace(/\s+/g, '');
      if (text.includes('已完成') || text === '完成' || text === '运行完成') return null;
      if (td.querySelector?.('.qsb-status-bar')) return td;
      return STATUS_TEXT_HINTS.some(h => text.includes(h)) ? td : null;
    }

    // 表头还没渲染出来的瞬间：退回文本探测，但要求格内有状态角标，
    // 避免把「数据入库」这类纯文字"失败"当成状态格
    for (const td of cells) {
      const text = td.textContent.replace(/\s+/g, '');
      if (text.includes('已完成') || text === '完成') continue;
      if (!STATUS_TEXT_HINTS.some(h => text.includes(h))) continue;
      if (td.querySelector?.('.ant-badge, .ant-tag, .ant-badge-status, .qsb-status-bar')) return td;
    }
    return null;
  }

  function renderBarInRow(row, jobUuid, date) {
    const d = date || row.getAttribute('data-date') || getCurrentDate();
    const cached = getJobCache(jobUuid, d);

    const targetCell = getStatusCell(row);
    if (!targetCell) return;

    let barEl = targetCell.querySelector('.qsb-status-bar');

    // 未缓存、正在加载中，或没有报错信息的任务：不显示任何文字/胶囊，保持界面干净
    if (!cached || cached.loading) {
      if (barEl) {
        isSelfModifyingDOM = true;
        try { barEl.remove(); } finally { setTimeout(() => { isSelfModifyingDOM = false; }, 0); }
      }
      return;
    }

    const { counts } = cached;
    let segHtml = '';
    const cats = ['1xxx', '2xxx', '3xxx', 'unknown'];
    cats.forEach(c => {
      const n = counts[c] || 0;
      if (n > 0) {
        // 色球圆点带数字，纯粹简约，去除 "1:" / "2:" / "3:"
        segHtml += `<span class="qsb-bar-seg qsb-seg-${c}" title="${c} (${CATEGORY_LABELS[c]}): ${n}项">${n}</span>`;
      }
    });

    isSelfModifyingDOM = true;
    try {
      // 如果没有任何报错数量，清空色球展示，不显示“分析中...”或空标签
      if (!segHtml) {
        if (barEl) barEl.remove();
        return;
      }

      if (!barEl) {
        barEl = document.createElement('span');
        barEl.className = 'qsb-status-bar';
        targetCell.appendChild(barEl);
      }
      if (barEl.innerHTML !== segHtml) {
        barEl.innerHTML = segHtml;
      }
    } finally {
      setTimeout(() => { isSelfModifyingDOM = false; }, 0);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Tooltip 交互（基于事件委托，彻底消除反复绑定与事件泄漏）
  // ═══════════════════════════════════════════════════════════════

  let _attachDebounce = null;
  function attachTooltipListeners(forceRebind = false) {
    // 去重：合并短时间内的多次调用
    clearTimeout(_attachDebounce);
    _attachDebounce = setTimeout(() => _attachTooltipListenersCore(forceRebind), 100);
  }

  function _attachTooltipListenersCore(forceRebind = false) {
    if (!isTaskExecuteActive()) return;
    const mainTable = getMainTable();
    if (!mainTable) return;
    const rows = mainTable.querySelectorAll('.ant-table-tbody tr.ant-table-row');
    const viewDate = getCurrentDate();

    rows.forEach(row => {
      const jobUuid = extractJobUuid(row);
      if (!jobUuid) return;

      // 只认「取数执行」列；「已完成」的格子不挂浮层
      const td = getStatusCell(row);

      // 清掉旧实现可能误标在别的列（数据入库等）上的痕迹
      row.querySelectorAll('td').forEach(cell => {
        if (cell === td) return;
        const stale = cell.querySelector?.('.qsb-status-bar');
        if (stale) stale.remove();
        cell.classList.remove('qsb-status-cell');
        cell.removeAttribute('data-job-uuid');
        cell.removeAttribute('data-date');
      });

      if (!td) {
        // 完成状态或无需显示浮层的行：彻底移除可能残留的旧色条与属性标记
        row.querySelectorAll('.qsb-status-bar').forEach(b => b.remove());
        row.querySelectorAll('.qsb-status-cell').forEach(cell => {
          cell.classList.remove('qsb-status-cell');
          cell.removeAttribute('data-job-uuid');
          cell.removeAttribute('data-date');
        });
        return;
      }

      row.setAttribute('data-date', viewDate);
      td.classList.add('qsb-status-cell');
      td.setAttribute('data-job-uuid', jobUuid);
      td.setAttribute('data-date', viewDate);
      td.style.cursor = 'pointer';
      renderBarInRow(row, jobUuid, viewDate);
    });
  }

  /**
   * 动态识别主表格内的状态单元格（抗 Vue/React 重新渲染抹除 class）
   * 判据只有一条：它是本行「取数执行」列的那一格 —— 不再靠"文本里有失败"猜。
   */
  function findStatusCell(target) {
    if (!target) return null;
    const td = target.closest?.('td');
    if (!td) return null;

    // 排除弹窗或抽屉中的表格
    const row = td.closest?.('.ant-table-row');
    if (!row || row.closest?.('.ant-modal, .ant-drawer')) return null;

    return getStatusCell(row) === td ? td : null;
  }

  function isTaskExecuteActive() {
    return Boolean(activePage && activePage.def && activePage.def.name === 'taskExecute');
  }

  let globalHoverTimer = null;
  function setupTooltipDelegation() {
    // 1. 悬停状态单元格触发展示（带防抖）
    document.addEventListener('mouseover', e => {
      if (!isTaskExecuteActive()) return;
      const td = findStatusCell(e.target);
      if (!td) return;

      const row = td.closest('.ant-table-row');
      const jobUuid = td.getAttribute('data-job-uuid') || (row ? extractJobUuid(row) : null);
      if (!jobUuid) return;

      // 动态补全标记（抗 Vue/React patch 抹除）
      if (!td.getAttribute('data-job-uuid')) td.setAttribute('data-job-uuid', jobUuid);
      if (!td.classList.contains('qsb-status-cell')) td.classList.add('qsb-status-cell');
      td.style.cursor = 'pointer';

      hoveredStatusTd = td;
      hoveredStatusJobUuid = jobUuid;

      // 如果当前正在显示的就是该浮层，直接取消隐藏倒计时，保持显示
      if (currentTooltipEl && currentTooltipJobUuid === jobUuid) {
        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
        return;
      }

      clearTimeout(globalHoverTimer);
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;

      globalHoverTimer = setTimeout(() => {
        // 只要用户鼠标依然停留在该单元格上，立即展示
        if (hoveredStatusTd === td) {
          showTooltip(td, jobUuid, td.getAttribute('data-date') || getCurrentDate());
        }
      }, HOVER_DEBOUNCE_MS);
    });

    // 2. 移出状态单元格触发延时隐藏
    document.addEventListener('mouseout', e => {
      if (!isTaskExecuteActive()) return;
      const td = findStatusCell(e.target);
      if (!td) return;
      // 如果鼠标只是移到了该单元格的内部子元素（如文字、色标等），不视为移开
      if (e.relatedTarget && td.contains(e.relatedTarget)) return;

      if (hoveredStatusTd === td) {
        hoveredStatusTd = null;
        hoveredStatusJobUuid = null;
      }
      clearTimeout(globalHoverTimer);
      scheduleHideTooltip();
    });

    // 3. 全局 pointermove 巡检：只要鼠标不在当前 anchor 且不在当前 tooltip 内，确保激活隐藏倒计时
    document.addEventListener('pointermove', e => {
      if (!isTaskExecuteActive()) return;
      if (!currentTooltipEl) return;
      const target = e.target;
      const inAnchor = currentTooltipAnchor && (currentTooltipAnchor === target || currentTooltipAnchor.contains(target));
      const inTooltip = currentTooltipEl && (currentTooltipEl === target || currentTooltipEl.contains(target));

      if (inAnchor || inTooltip) {
        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
      } else {
        if (!tooltipHideTimer) {
          scheduleHideTooltip();
        }
      }
    }, { passive: true });

    // 4. 点击外部立即关闭
    document.addEventListener('mousedown', e => {
      if (!isTaskExecuteActive()) return;
      if (!currentTooltipEl) return;
      if (currentTooltipEl.contains(e.target) || currentTooltipAnchor?.contains(e.target)) return;
      hideTooltip();
    }, true);

    // 5. 页面或表格滚动时关闭（允许 tooltip 内部内容滚动）
    window.addEventListener('scroll', e => {
      if (!isTaskExecuteActive()) return;
      if (!currentTooltipEl) return;
      if (e.target && currentTooltipEl.contains(e.target)) return;
      hideTooltip();
    }, true);

    // 6. 按 Esc 键关闭
    document.addEventListener('keydown', e => {
      if (!isTaskExecuteActive()) return;
      if (e.key === 'Escape' && currentTooltipEl) {
        hideTooltip();
      }
    });

    // 7. 窗口失焦时关闭
    window.addEventListener('blur', () => {
      if (!isTaskExecuteActive()) return;
      hideTooltip();
    });
  }

  function extractJobUuid(row) {
    if (!row) return null;

    // 1. data-row-key（Ant Table 默认渲染，最权威直接，无缓存滞后风险）
    const key = row.getAttribute('data-row-key');
    if (key) return key;

    // 2. React Fiber
    try {
      const fiberKey = Object.keys(row).find(k =>
        k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber'));
      if (fiberKey) {
        let fiber = row[fiberKey];
        for (let depth = 0; fiber && depth < 20; depth++) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props?.record?.jobUuid) return props.record.jobUuid;
          if (props?.['data-row-key']) return props['data-row-key'];
          fiber = fiber.return;
        }
      }
    } catch (_) { }

    // 3. Vue 实例
    try {
      const vueKey = Object.keys(row).find(k => k.startsWith('__vue'));
      if (vueKey) {
        const vm = row[vueKey];
        const rec = vm?.record || vm?.$props?.record || vm?.ctx?.record;
        if (rec?.jobUuid) return rec.jobUuid;
      }
    } catch (_) { }

    return null;
  }

  function showTooltip(anchorEl, jobUuid, date) {
    if (!anchorEl || !anchorEl.isConnected) {
      hideTooltip();
      return;
    }

    hideTooltip();
    currentTooltipJobUuid = jobUuid;
    currentTooltipAnchor = anchorEl;

    const d = date || anchorEl.getAttribute('data-date') || anchorEl.closest('.ant-table-row')?.getAttribute('data-date') || getCurrentDate();
    const cached = getJobCache(jobUuid, d);
    if (!cached) return; // 非预加载目标（已完成），不显示

    const tooltip = document.createElement('div');
    tooltip.className = 'qsb-tooltip';

    if (cached.loading) {
      tooltip.innerHTML = '<div class="qsb-tooltip-loading">⏳ 加载详情中...</div>';
    } else if (cached.text === '加载失败') {
      tooltip.innerHTML = '<div class="qsb-tooltip-loading">❌ 加载失败，请刷新重试</div>';
    } else {
      let html = '<div class="qsb-tooltip-header">异常统计: ';
      for (const cat of ['1xxx', '2xxx', '3xxx', 'unknown']) {
        const n = cached.counts[cat] || 0;
        html += `<span class="qsb-tooltip-cat qsb-cat-${cat}">${cat}: ${n}个</span> `;
      }
      html += '</div>';

      if (cached.details.length) {
        html += '<div class="qsb-tooltip-body">';
        for (const d of cached.details) {
          html += `<div class="qsb-tooltip-card">
            <div class="qsb-card-title">
              <div>
                <span class="qsb-err-code">${esc(d.errCode)}</span>
                <span class="qsb-tooltip-cat qsb-cat-${d.category}">${CATEGORY_LABELS[d.category]}</span>
                <span class="qsb-card-shop">${esc(d.shopName)}</span>
              </div>
              ${d.rawMsg ? `<button class="qsb-copy-btn" data-raw="${esc(d.rawMsg)}" title="复制完整底层日志">📋 复制</button>` : ''}
            </div>
            <div class="qsb-card-row">
              <span class="qsb-card-label">连接器:</span><b>[${esc(d.action)}]</b>
              ${d.runTime ? `<span style="margin-left: 8px; color: #8c8c8c;">耗时: ${esc(d.runTime)}</span>` : ''}
            </div>
            <div class="qsb-card-row">
              <span class="qsb-card-label">失败原因:</span><span style="color: #cf1322;">${esc(d.reason)}</span>
            </div>
            ${d.target ? `<div class="qsb-card-row"><span class="qsb-card-label">异常元素:</span><span class="qsb-card-val-elem">${esc(d.target)}</span></div>` : ''}
          </div>`;
        }
        html += '</div>';
      } else {
        html += '<div class="qsb-tooltip-loading">无具体错误详情</div>';
      }
      tooltip.innerHTML = html;

      // 绑定复制按钮事件
      tooltip.querySelectorAll('.qsb-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const raw = btn.getAttribute('data-raw');
          if (navigator.clipboard && raw) {
            navigator.clipboard.writeText(raw).then(() => {
              btn.textContent = '✓ 已复制';
              btn.classList.add('copied');
              setTimeout(() => {
                btn.textContent = '📋 复制';
                btn.classList.remove('copied');
              }, 1500);
            });
          }
        });
      });
    }

    // 定位：锚点下方
    const rect = anchorEl.getBoundingClientRect();
    tooltip.style.left = rect.left + 'px';
    tooltip.style.top = (rect.bottom + 6) + 'px';

    document.body.appendChild(tooltip);

    // 边界修正
    const tr = tooltip.getBoundingClientRect();
    if (tr.right > window.innerWidth - 10)
      tooltip.style.left = Math.max(0, window.innerWidth - tr.width - 10) + 'px';
    if (tr.bottom > window.innerHeight - 10)
      tooltip.style.top = (rect.top - tr.height - 6) + 'px';

    // 鼠标进入 tooltip 时保持显示
    tooltip.addEventListener('mouseenter', () => {
      isMouseOverTooltip = true;
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    });
    tooltip.addEventListener('mouseleave', () => {
      isMouseOverTooltip = false;
      scheduleHideTooltip();
    });

    currentTooltipEl = tooltip;
  }

  function hideTooltip() {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = null;
    clearTimeout(globalHoverTimer);
    globalHoverTimer = null;
    if (currentTooltipEl) { currentTooltipEl.remove(); currentTooltipEl = null; }
    currentTooltipJobUuid = null;
    currentTooltipAnchor = null;
    hoveredStatusTd = null;
    hoveredStatusJobUuid = null;
    isMouseOverTooltip = false;
  }

  function scheduleHideTooltip() {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(() => {
      if (!hoveredStatusTd && !isMouseOverTooltip) {
        hideTooltip();
      }
    }, TOOLTIP_HIDE_DELAY_MS);
  }

  // ═══════════════════════════════════════════════════════════════
  // 页面变化监听
  // ═══════════════════════════════════════════════════════════════
  let rearmPageObserver = null;   // SPA 重进目标页时重新接管表格观察
  let tableObserver = null;
  let mutationDebounce = null;
  let currentObservedTarget = null;
  let pageChangeListenersReady = false;

  function disconnectTableObserver() {
    if (tableObserver) {
      tableObserver.disconnect();
      currentObservedTarget = null;
    }
    clearTimeout(mutationDebounce);
    mutationDebounce = null;
  }

  function setupPageChangeListeners() {
    if (pageChangeListenersReady) return;
    pageChangeListenersReady = true;

    tableObserver = new MutationObserver(mutations => {
      // 0. 当前页面必须是 taskExecute
      if (!isTaskExecuteActive()) return;

      // 1. 核心防护：脚本内部正在操作 DOM 时，直接丢弃回调，杜绝自激死循环
      if (isSelfModifyingDOM) return;

      // 2. 过滤掉脚本自身引起的 DOM 变化
      const isOwnChange = mutations.every(m => {
        const t = m.target;
        if (t.closest?.('.qsb-tooltip, .qsb-status-bar, .qsb-filter-bar, .qsb-filter-form-item')) return true;
        if (t.classList?.contains('qsb-highlight')) return true;
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (
            n.classList?.contains('qsb-status-bar') ||
            n.classList?.contains('qsb-tooltip') ||
            n.classList?.contains('qsb-highlight')
          )) return true;
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && (
            n.classList?.contains('qsb-status-bar') ||
            n.classList?.contains('qsb-tooltip') ||
            n.classList?.contains('qsb-highlight')
          )) return true;
        }
        return false;
      });
      if (isOwnChange) return;

      // 3. 只关心表格行的实际变化
      let tableChanged = false;
      for (const m of mutations) {
        if (m.target.closest?.('.ant-table-tbody') ||
          m.target.classList?.contains('ant-table-tbody')) { tableChanged = true; break; }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (n.querySelector?.('.ant-table-row') ||
            n.classList?.contains('ant-table-row'))) { tableChanged = true; break; }
        }
        if (tableChanged) break;
      }
      if (!tableChanged) return;

      // 尝试收敛观察范围到表格容器，停止监听全页 body
      ensureNarrowObserver();

      // 防抖合并：短时间内多次表格变化只处理一次
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        if (!isTaskExecuteActive()) return;
        attachTooltipListeners();
        if (filterInput?.value) applyFilter(filterInput.value);
      }, 500);
    });

    function ensureNarrowObserver() {
      if (!isTaskExecuteActive()) return;
      const tableWrapper = document.querySelector('.ant-table-wrapper') || document.querySelector('.ant-table');
      const target = tableWrapper || document.body;
      if (target !== currentObservedTarget) {
        if (tableObserver) {
          tableObserver.disconnect();
          tableObserver.observe(target, { childList: true, subtree: true });
          currentObservedTarget = target;
        }
      }
    }

    ensureNarrowObserver();
    rearmPageObserver = ensureNarrowObserver;   // 供 SPA 重进目标页时重新接管（旧容器可能已被销毁）

    // 点击事件：日期切换 / 搜索 / 重置 / 分页
    document.addEventListener('click', e => {
      if (!isTaskExecuteActive()) return;
      const t = e.target;
      if (t.closest?.('.ant-tabs-tab') || t.closest?.('.ant-radio-button-wrapper')) {
        resetPreloadState();
      }
      if (t.closest?.('button')) {
        const text = t.textContent.trim().replace(/\s+/g, '');
        if (text === '搜索' || text === '查询') resetPreloadState();
        if (text === '重置') {
          if (filterInput) { filterInput.value = ''; if (countBadge) countBadge.textContent = ''; }
          resetPreloadState();
        }
      }
      if (t.closest?.('.ant-pagination')) resetPreloadState();
    }, true);
  }

  // ═══════════════════════════════════════════════════════════════
  // 工具
  // ═══════════════════════════════════════════════════════════════
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
  const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => _escMap[c]); }

  // ═══════════════════════════════════════════════════════════════
  // 零依赖 xlsx 生成（ZIP STORE + 最小 OOXML）
  // @grant none 拿不到 GM_download，也不允许引 JSZip，所以自己打包：
  // 不压缩（method=0），全部字符串走 inlineStr，省掉 sharedStrings 这一层。
  // 版式对齐「租户名ETL映射表」：3 行标题（合并 A:D，宋体12）+ 1 行加粗表头 + 字段行。
  // ═══════════════════════════════════════════════════════════════
  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** 以 STORE 方式把 [{name, data}] 打成 zip 字节流 */
  function zipStore(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = encoder.encode(f.name);
      const data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
      const sum = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // 解压所需版本
      local.setUint16(8, 0, true);         // 压缩方式 0 = STORE
      local.setUint16(12, 0x21, true);     // 固定时间戳：同样的输入永远出同样的字节
      local.setUint32(14, sum, true);
      local.setUint32(18, data.length, true);  // 压缩后大小 == 原始大小
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(local.buffer), name, data);

      const head = new DataView(new ArrayBuffer(46));
      head.setUint32(0, 0x02014b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 20, true);
      head.setUint16(14, 0x21, true);
      head.setUint32(16, sum, true);
      head.setUint32(20, data.length, true);
      head.setUint32(24, data.length, true);
      head.setUint16(28, name.length, true);
      head.setUint32(42, offset, true);
      central.push(new Uint8Array(head.buffer), name);

      offset += 30 + name.length + data.length;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
    let total = 0;
    for (const c of all) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of all) { out.set(c, pos); pos += c.length; }
    return out;
  }

  /** 0 → A，26 → AA */
  function colLetter(index) {
    let s = '';
    let i = index;
    while (i >= 0) {
      s = String.fromCharCode(65 + (i % 26)) + s;
      i = Math.floor(i / 26) - 1;
    }
    return s;
  }

  const XLSX_HEADER = ['字段英文名', '字段中文名', '数据类型', '长度'];

  // 三个样式位：0=正文(宋体11) 1=标题(宋体12+浅蓝底) 2=表头(宋体11加粗)
  // 1/2 都挂黑色细边框，让前四行（3 行标题 + 1 行表头）自成一个有框的表头区。
  // cellStyles 那一段不能少，否则部分解析器报「缺少默认样式」
  // border 子元素顺序必须是 left/right/top/bottom，乱了 Excel 会拒开。
  const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="3">'
    + '<font><sz val="11"/><name val="宋体"/></font>'
    + '<font><sz val="12"/><name val="宋体"/></font>'
    + '<font><b/><sz val="11"/><name val="宋体"/></font>'
    + '</fonts>'
    + '<fills count="3">'
    + '<fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
    + '</fills>'
    + '<borders count="2">'
    + '<border/>'
    + '<border>'
    + '<left style="thin"><color rgb="FF000000"/></left>'
    + '<right style="thin"><color rgb="FF000000"/></right>'
    + '<top style="thin"><color rgb="FF000000"/></top>'
    + '<bottom style="thin"><color rgb="FF000000"/></bottom>'
    + '</border>'
    + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

  function xlsxCell(col, row, value, styleId) {
    const ref = colLetter(col) + row;
    const text = value == null ? '' : String(value);
    return `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  }

  /** block: { connectorName, tableNameCn, tableNameEn, rows: [[英文名, 中文名, 类型, 长度]] } */
  function buildSheetXml(block) {
    const lines = [];
    const merges = [];
    let r = 0;

    const titleRow = text => {
      r++;
      merges.push(`A${r}:D${r}`);
      // A:D 四个格子都套同一套样式：合并区域的外框右/下边是靠 D 列那格画的，
      // 只给 A 列设样式时某些渲染器会缺右边框。合并会把内部竖线吃掉，不会露出来。
      lines.push(`<row r="${r}">`
        + [text, '', '', ''].map((value, i) => xlsxCell(i, r, value, 1)).join('')
        + '</row>');
    };
    titleRow(`连接器名称：${block.connectorName || ''}`);
    titleRow(`中文表名：${block.tableNameCn || ''}`);
    titleRow(`英文表名：${block.tableNameEn || ''}`);

    r++;
    lines.push(`<row r="${r}">`
      + XLSX_HEADER.map((text, i) => xlsxCell(i, r, text, 2)).join('')
      + '</row>');

    for (const row of block.rows) {
      r++;
      lines.push(`<row r="${r}">`
        + row.map((value, i) => xlsxCell(i, r, value, 0)).join('')
        + '</row>');
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetFormatPr defaultRowHeight="15.6"/>'
      + '<cols>'
      + '<col min="1" max="1" width="22" customWidth="1"/>'
      + '<col min="2" max="2" width="30" customWidth="1"/>'
      + '<col min="3" max="3" width="12" customWidth="1"/>'
      + '<col min="4" max="4" width="10" customWidth="1"/>'
      + '</cols>'
      + `<sheetData>${lines.join('')}</sheetData>`
      + `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      + '</worksheet>';
  }

  /**
   * 多 sheet 工作簿：sheets = [{ name, block }] → Uint8Array
   * 部件顺序：sheet1..sheetN 依次拿 rId1..rIdN，styles 固定排最后（rId N+1），
   * workbook.xml 里的 r:id 与 rels 必须一一对上，否则 Excel 报「内容有问题」。
   */
  function buildWorkbook(sheets) {
    const sheetParts = sheets.map((s, i) => {
      const no = i + 1;
      return {
        rels: `<Relationship Id="rId${no}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${no}.xml"/>`,
        type: `<Override PartName="/xl/worksheets/sheet${no}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        sheet: `<sheet name="${esc(s.name)}" sheetId="${no}" r:id="rId${no}"/>`,
        part: { name: `xl/worksheets/sheet${no}.xml`, data: buildSheetXml(s.block) }
      };
    });
    const styleRid = `rId${sheets.length + 1}`;

    const files = [
      {
        name: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
          + sheetParts.map(p => p.type).join('')
          + '</Types>'
      },
      {
        name: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
          + '</Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
          + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + `<sheets>${sheetParts.map(p => p.sheet).join('')}</sheets>`
          + '</workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + sheetParts.map(p => p.rels).join('')
          + `<Relationship Id="${styleRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
          + '</Relationships>'
      },
      { name: 'xl/styles.xml', data: XLSX_STYLES }
    ].concat(sheetParts.map(p => p.part));

    return zipStore(files);
  }

  /** Excel 限制：sheet 名 ≤31 字，且不能含 \ / ? * [ ] : */
  function toSheetName(raw) {
    const s = String(raw || '').replace(/[\\/?*[\]:]/g, '_').trim();
    return (s || 'Sheet1').slice(0, 31);
  }

  /** Excel 要求 sheet 名不区分大小写唯一；重名追加 _2、_3…，仍守 31 字上限 */
  function uniqueSheetName(raw, used) {
    const base = toSheetName(raw);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = `_${n++}`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  }

  /** 文件名里不能出现的字符；过长会撞 Windows 路径限制 */
  function toFileNamePart(raw) {
    return String(raw || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80);
  }

  function downloadXlsx(bytes, fileName) {
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ═══════════════════════════════════════════════════════════════
  // 页面注册表：一个脚本承载多个页面的能力，按 route 激活
  // 约束：同一时刻只有一个页面处于激活状态，因此引擎级状态
  //      （errorCache / 预加载队列 / tooltip 单例）可以共用，
  //      页面级状态由各自的 state 承载，离开时随 teardown 清理。
  // ═══════════════════════════════════════════════════════════════
  const PAGES = [];               // { name, route, setup(state), teardown(state) }

  let interceptorReady = false;   // 样式与请求拦截：整份文档只装一次
  let pageHooksReady = false;     // 事件委托与页面监听：整份文档只装一次
  let activePage = null;          // { def, state }；null 表示当前不在任何受管页面

  function registerPage(def) {
    PAGES.push(def);
  }

  function matchPage() {
    return PAGES.find(p => p.route.test(location.pathname)) || null;
  }

  function ensureInterceptor() {
    if (interceptorReady) return;
    interceptorReady = true;
    injectStyles();
    setupResponseInterceptor();
  }

  function ensurePageHooks() {
    if (pageHooksReady) return;
    pageHooksReady = true;
    setupTooltipDelegation();
    setupPageChangeListeners();
  }

  function enterPage(def) {
    ensureInterceptor();

    // 同一页面且 UI 还在（仅 query 变化、分页、keep-alive 回退），不重复激活
    if (activePage && activePage.def === def && document.querySelector('.qsb-filter-bar')) return;

    if (!activePage) {
      activePage = { def, state: { runId: 0, barInjected: false, loopRunning: false } };
      console.log(LOG_TAG, VERSION, `${def.name} 目标页面已激活`);
    }
    ensurePageHooks();
    if (rearmPageObserver) rearmPageObserver();     // 旧容器可能已随路由销毁
    def.setup(activePage.state);
  }

  function leavePage() {
    if (!activePage) return;
    const { def, state } = activePage;
    activePage = null;            // 先摘掉，teardown 里再进入别的页面时不会被误判为同一页
    state.runId++;                // 作废仍在运行的重试循环
    state.loopRunning = false;
    state.barInjected = false;
    def.teardown(state);
  }

  function onRouteMaybeChanged() {
    const def = matchPage();
    const activeDef = activePage ? activePage.def : null;
    if (def !== activeDef) leavePage();
    if (def) enterPage(def);
  }

  function watchRoute() {
    // 站内跳转（vue-router / react-router）最终都走 pushState / replaceState
    ['pushState', 'replaceState'].forEach(name => {
      const orig = history[name];
      history[name] = function (...args) {
        const ret = orig.apply(this, args);
        try { onRouteMaybeChanged(); } catch (_) { }
        return ret;
      };
    });
    window.addEventListener('popstate', onRouteMaybeChanged);
    window.addEventListener('hashchange', onRouteMaybeChanged);

    // 兜底：部分框架在异步守卫后才改 URL，或直接赋值 location
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        onRouteMaybeChanged();
        return;
      }
      // 同一路径下页面被整体重渲染（容器销毁重建）时补注入；
      // 只在曾经注入成功过才补，避免表单结构变化时无限重试刷屏
      const state = activePage?.state;
      if (state && state.barInjected && !state.loopRunning && !document.querySelector('.qsb-filter-bar')) {
        state.barInjected = false;
        enterPage(activePage.def);
      }
    }, ROUTE_POLL_MS);
  }

  function start() {
    watchRoute();
    onRouteMaybeChanged();
  }

  // ═══════════════════════════════════════════════════════════════
  // 注册：任务运行记录页（筛选 + 报错外显）
  // ═══════════════════════════════════════════════════════════════
  onResponse('/job/record/new', {
    onRequest: tryExtractDateFromBody,      // 从请求体取 dateTime
    onResponse: onListResponseReceived      // 从响应体取记录，排队预加载
  });

  registerPage({
    name: 'taskExecute',
    route: TASK_EXECUTE_ROUTE,
    setup(state) {
      const runId = ++state.runId;
      state.loopRunning = true;
      const finish = () => {
        if (runId === state.runId) state.loopRunning = false;
      };

      let retries = 0;
      const tryInject = () => {
        if (runId !== state.runId || !TASK_EXECUTE_ROUTE.test(location.pathname)) { finish(); return; }
        if (retries >= INJECT_MAX_RETRIES) {
          console.warn(LOG_TAG, '超时：未找到目标表单');
          finish();
          return;
        }
        if (injectFilterBar()) {
          state.barInjected = true;
          console.log(LOG_TAG, '筛选栏已注入');
          finish();
          setTimeout(attachTooltipListeners, 1000);
        } else {
          retries++;
          setTimeout(tryInject, INJECT_RETRY_MS);
        }
      };
      tryInject();
    },
    teardown() {
      // 1. 物理移除筛选栏注入的 DOM 节点，防止下次进入命中已死节点导致 filterInput 锁死为 null
      document.querySelectorAll('.qsb-filter-form-item, .qsb-filter-bar').forEach(el => el.remove());
      filterInput = null;         // 页码/筛选框句柄随 DOM 一起失效，清空避免跨页残留
      countBadge = null;
      filterAnchorBtn = null;

      // 2. 解除窗口 resize 监听器
      if (alignHooked) {
        window.removeEventListener('resize', onFilterBarResize);
        alignHooked = false;
      }

      // 3. 断开表格 MutationObserver 并清理防抖定时器
      disconnectTableObserver();

      // 4. 清理延迟绑定与防抖定时器，杜绝离开页面后的异步 DOM 操作
      clearTimeout(_attachDebounce);
      _attachDebounce = null;
      clearTimeout(postListBindTimer);
      postListBindTimer = null;

      // 5. 清理对表格 DOM 的强引用缓存
      _statusColCache = { table: null, idx: -1 };
      _storeColIdx = -1;

      // 6. 中断当前预加载网络请求并关闭浮层（不清除已有正确缓存）
      resetPreloadState();
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 注册：数据中心页（展开行内「导出Excel」列）
  // 导出的是「表字段映射」，字段定义只有一个来源：conn/mapper/get。
  // 页面列表本身不返回字段，所以点按钮时才按需请求，点一次缓存一个连接器。
  // ═══════════════════════════════════════════════════════════════
  const EXPORT_COL_LABEL = '导出Excel';
  const tableDefCache = new Map();     // connectorId -> Promise<表定义数组>
  let exportObserver = null;
  let exportInjectTimer = null;

  /** 表头纯文字：扣掉自己塞进去的按钮节点，否则 headerIndex 再也匹配不上原文 */
  function headerText(th) {
    if (!th) return '';
    const nodes = th.childNodes;
    if (!nodes || !nodes.length) return (th.textContent || '').trim();   // 桩环境 / 无子节点
    let out = '';
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 1 && node.dataset && node.dataset.qsbCopy) continue;   // 本脚本的复制按钮
      out += node.textContent || '';
    }
    return out.trim();
  }

  /** 按表头文字取列索引：站点调列序不会指错 */
  function headerIndex(scope, label) {
    if (!scope) return -1;
    const ths = scope.querySelectorAll('thead th');
    for (let i = 0; i < ths.length; i++) {
      if (headerText(ths[i]) === label) return i;
    }
    return -1;
  }

  /** 嵌套表的行往上找所属的连接器行，取 connectorId 与连接器名称 */
  function findOwnerRow(innerRow) {
    const expandedTr = innerRow.closest('tr.ant-table-expanded-row') || innerRow.closest('tr');
    let prev = expandedTr ? expandedTr.previousElementSibling : null;
    while (prev && !prev.classList.contains('ant-table-row')) prev = prev.previousElementSibling;
    if (!prev) return { id: '', name: '' };

    // 外层表是 fixed-header，表头在另一个 table 里，得从 container 里找
    const outerTable = prev.closest('table');
    const container = outerTable && outerTable.closest('.ant-table-container');
    const headScope = (container && container.querySelector('.ant-table-header')) || outerTable;
    const idx = headerIndex(headScope, '连接器名称');
    const cell = prev.querySelectorAll('td')[idx >= 0 ? idx : 1];
    return {
      id: prev.getAttribute('data-row-key') || '',
      name: cell ? (cell.textContent || '').trim() : ''
    };
  }

  function injectExportColumns() {
    const tables = document.querySelectorAll('.ant-table-expanded-row table');
    for (const table of tables) {
      const enIdx = headerIndex(table, '表英文名称');
      if (enIdx < 0) continue;
      const cnIdx = headerIndex(table, '表中文名称');

      // 嵌套表是 table-layout:auto，而 colgroup 只有 6 个 <col> 却对应 9 列：
      // 不补一个 <col>，新列会白拿 20% 宽度、还把后面几列挤瘦。
      // 在「表英文名称」后面插一条固定宽度，后面的列宽比例就回到原来的样子。
      const colgroup = table.querySelector('colgroup');
      if (colgroup && !colgroup.querySelector('col[data-qsb-export]') && colgroup.children[1]) {
        const col = document.createElement('col');
        col.setAttribute('data-qsb-export', '');
        col.style.width = '96px';
        colgroup.children[1].insertAdjacentElement('afterend', col);
      }

      const anchorTh = table.querySelectorAll('thead th')[enIdx];
      if (anchorTh && !table.querySelector('thead th[data-qsb-export]')) {
        const th = document.createElement('th');
        th.className = anchorTh.className;
        th.setAttribute('data-qsb-export', '');

        // 表头文字本身就是入口：点它 = 导出本连接器所有启用表（每表一个 sheet）
        const link = document.createElement('span');
        link.className = 'qsb-export-all';
        link.textContent = EXPORT_COL_LABEL;
        link.title = '导出本连接器所有「启用」表的 ETL 配置（每张表一个 Sheet）';
        th.appendChild(link);

        anchorTh.insertAdjacentElement('afterend', th);
      }

      for (const row of table.querySelectorAll('tbody tr.ant-table-row')) {
        if (row.querySelector('td[data-qsb-export]')) continue;
        const cells = row.querySelectorAll('td');
        const anchorTd = cells[enIdx];
        if (!anchorTd) continue;

        const owner = findOwnerRow(row);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ant-btn ant-btn-link qsb-export-btn';
        btn.textContent = EXPORT_COL_LABEL;
        btn.dataset.qsbEn = (anchorTd.textContent || '').trim();
        btn.dataset.qsbCn = cnIdx >= 0 && cells[cnIdx] ? (cells[cnIdx].textContent || '').trim() : '';
        btn.dataset.qsbConnector = owner.name;
        btn.dataset.qsbConnectorId = owner.id;

        const td = document.createElement('td');
        td.className = anchorTd.className;
        td.setAttribute('data-qsb-export', '');
        td.appendChild(btn);
        anchorTd.insertAdjacentElement('afterend', td);
      }
    }
  }

  function setExportBtn(btn, text, busy, restoreMs) {
    btn.textContent = text;
    btn.disabled = !!busy;
    btn.dataset.qsbBusy = busy ? '1' : '';
    if (restoreMs) {
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = EXPORT_COL_LABEL;
        btn.disabled = false;
        btn.dataset.qsbBusy = '';
      }, restoreMs);
    }
  }

  function getTableDefs(connectorId) {
    if (!connectorId) return Promise.resolve([]);
    if (!tableDefCache.has(connectorId)) {
      const pending = apiPost('/conn/mapper/get', { connectorId })
        .then(res => (res && String(res.code) === '10000' && Array.isArray(res.bizData)) ? res.bizData : [])
        .catch(err => { tableDefCache.delete(connectorId); throw err; });
      tableDefCache.set(connectorId, pending);
    }
    return tableDefCache.get(connectorId);
  }

  function pickTable(tables, tableNameEn, tableNameCn) {
    return tables.find(t => t.tableNameEn === tableNameEn)
      || tables.find(t => t.tableNameCn === tableNameCn)
      || null;
  }

  /**
   * 取一个连接器的全部表定义：先用行上的 data-row-key 当 connectorId 直接问；
   * 取不到就用连接器全名在 connector/page 里精确匹配换 id 再问一次。
   * 行 key 是否等于 conn/mapper/get 的 connectorId 没有文档背书，所以必须有第二条路。
   */
  async function getConnectorTables(connectorName, hintId) {
    if (hintId) {
      const tables = await getTableDefs(hintId);
      if (tables.length) return tables;
    }
    if (!connectorName) return [];

    const res = await apiPost('/connector/page', {
      pageSize: 20, pageNo: 1, connectorName,
      publishStatus: '', bizParamType: '', tagIds: [], industryProducts: '1'
    });
    const records = (res && res.bizData && res.bizData.records) || [];
    for (const rec of records) {
      if (!rec || rec.connectorName !== connectorName || !rec.id) continue;
      const tables = await getTableDefs(String(rec.id));
      if (tables.length) return tables;
    }
    return [];
  }

  async function resolveTableDef(connectorName, tableNameEn, tableNameCn, hintId) {
    return pickTable(await getConnectorTables(connectorName, hintId), tableNameEn, tableNameCn);
  }

  async function exportTable(btn) {
    const tableNameEn = btn.dataset.qsbEn || '';
    const tableNameCn = btn.dataset.qsbCn || '';
    const connectorName = btn.dataset.qsbConnector || '';
    const connectorId = btn.dataset.qsbConnectorId || '';

    setExportBtn(btn, '导出中…', true);
    try {
      const table = await resolveTableDef(connectorName, tableNameEn, tableNameCn, connectorId);
      if (!table) {
        console.warn(LOG_TAG, '未取到表定义', { connectorName, tableNameEn, connectorId });
        setExportBtn(btn, '未取到字段', true, 2500);
        return;
      }
      const fields = Array.isArray(table.fields) ? table.fields : [];
      if (!fields.length) {
        setExportBtn(btn, '无字段', true, 2500);
        return;
      }

      const cn = table.tableNameCn || tableNameCn;
      const en = table.tableNameEn || tableNameEn;
      const bytes = buildWorkbook([{
        name: toSheetName(cn || en),
        block: {
          connectorName: connectorName || cn,
          tableNameCn: cn,
          tableNameEn: en,
          rows: fields.map(f => [f.fieldName, f.fieldComment, f.fieldAttr, f.fieldLength])
        }
      }]);

      downloadXlsx(bytes, `${toFileNamePart(cn || en)}_${toFileNamePart(en)}.xlsx`);
      setExportBtn(btn, '已导出', true, 1500);
    } catch (err) {
      console.warn(LOG_TAG, '导出失败:', err);
      setExportBtn(btn, '导出失败', true, 2500);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // 「复制启用表名」：嵌套表表头 表中文名称 / 表英文名称 各塞一个按钮。
  // 纯 DOM 读取，不请求接口。启用状态读 ant-switch 的 aria-checked（实测形态），
  // 换 checkbox / 文字也能兜住；三级全落空时不静默猜，照抄全部并在反馈里标出。
  // ───────────────────────────────────────────────────────────────
  const COPYNAME_LABEL = '复制';
  const COPYNAME_COLS = [
    { kind: 'cn', label: '表中文名称' },
    { kind: 'en', label: '表英文名称' }
  ];
  const ENABLED_COL_LABEL = '是否启用';

  /** 启用状态三态：true=启用 / false=停用 / null=认不出 */
  function readEnabledState(cell) {
    if (!cell) return null;
    const sw = cell.querySelector('[role="switch"]') || cell.querySelector('.ant-switch');
    if (sw) {
      const aria = sw.getAttribute('aria-checked');
      if (aria === 'true') return true;
      if (aria === 'false') return false;
      if (sw.classList && sw.classList.contains('ant-switch-checked')) return true;
      if (sw.classList && sw.classList.contains('ant-switch')) return false;
    }
    const box = cell.querySelector('input[type="checkbox"]');
    if (box) return !!box.checked;
    const text = (cell.textContent || '').replace(/\s+/g, '');
    if (!text) return null;
    if (/未启用|不启用|停用|禁用|关闭/.test(text)) return false;
    if (/启用|开启|正常|^是$/.test(text)) return true;
    return null;
  }

  /** 一张嵌套表 → 某列在「启用」行上的表名（表格行序，未去重） */
  function collectTableNames(table, kind) {
    const colIdx = headerIndex(table, kind === 'en' ? '表英文名称' : '表中文名称');
    if (colIdx < 0) return { names: [], unrecognized: false };
    const stateIdx = headerIndex(table, ENABLED_COL_LABEL);
    const names = [];
    let unrecognized = stateIdx < 0;      // 连「是否启用」列都找不到，口径已不可信
    for (const row of table.querySelectorAll('tbody tr.ant-table-row')) {
      const cells = row.querySelectorAll('td');
      const cell = cells[colIdx];
      if (!cell) continue;
      const name = (cell.textContent || '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      if (stateIdx >= 0) {
        const state = readEnabledState(cells[stateIdx]);
        if (state === false) continue;
        if (state === null) unrecognized = true;
      }
      names.push(name);
    }
    return { names, unrecognized };
  }

  /** onlyTable 给了就只扫这一张（Alt+点击），否则扫全页所有已展开的嵌套表 */
  function collectEnabledNames(kind, onlyTable) {
    const tables = onlyTable
      ? [onlyTable]
      : Array.from(document.querySelectorAll('.ant-table-expanded-row table'));
    const names = [];
    const seen = new Set();
    let unrecognized = false;
    for (const table of tables) {
      const one = collectTableNames(table, kind);
      if (one.unrecognized) unrecognized = true;
      for (const name of one.names) {
        if (seen.has(name)) continue;   // 跨连接器重名表：纯名单里重复没有意义
        seen.add(name);
        names.push(name);
      }
    }
    return { names, unrecognized, tableCount: tables.length };
  }

  /** 写剪贴板三级降级：Clipboard API → execCommand → 可手动复制的面板 */
  async function copyText(text) {
    try {
      if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 权限被拒 → 降级 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch (_) { /* 再降级 */ }

    showCopyPanel(text);
    return false;
  }

  function showCopyPanel(text) {
    document.querySelectorAll('.qsb-copy-panel').forEach(el => el.remove());
    const box = document.createElement('div');
    box.className = 'qsb-copy-panel';
    box.innerHTML = '<div class="qsb-copy-panel-title">剪贴板不可用，请手动复制（Ctrl+C）</div>'
      + '<textarea readonly></textarea>'
      + '<div class="qsb-copy-panel-foot">'
      + '<span class="qsb-copy-panel-count"></span>'
      + '<button type="button" class="ant-btn ant-btn-primary ant-btn-sm qsb-copy-panel-close">关闭</button>'
      + '</div>';

    const ta = box.querySelector('textarea');
    ta.value = text;
    box.querySelector('.qsb-copy-panel-count').textContent =
      `${text.split('\n').filter(Boolean).length} 条`;
    box.querySelector('.qsb-copy-panel-close').addEventListener('click', () => box.remove());

    document.body.appendChild(box);
    ta.focus();
    ta.select();
  }

  function flashCopyBtn(btn, text, ms) {
    clearTimeout(btn._qsbCopyTimer);
    btn.textContent = text;
    btn.classList.add('copied');
    btn._qsbCopyTimer = setTimeout(() => {
      if (btn.isConnected === false) return;
      btn.textContent = COPYNAME_LABEL;
      btn.classList.remove('copied');
    }, ms || 1600);
  }

  async function handleCopyNameClick(btn, onlyTable) {
    const kind = btn.dataset.qsbCopy === 'en' ? 'en' : 'cn';
    const { names, unrecognized, tableCount } = collectEnabledNames(kind, onlyTable);
    if (!names.length) {
      flashCopyBtn(btn, '无启用表');
      return;
    }
    console.log(LOG_TAG, `复制启用表${kind === 'en' ? '英文' : '中文'}名 ${names.length} 条`
      + `（扫描 ${tableCount} 张表${unrecognized ? '，含启用状态未识别的行' : ''}）`, names);

    const ok = await copyText(names.join('\n'));
    flashCopyBtn(btn, ok ? `已复制 ${names.length} 条` : `请手动复制 ${names.length} 条`, 2200);
  }

  function injectCopyNameButtons() {
    for (const table of document.querySelectorAll('.ant-table-expanded-row table')) {
      const ths = table.querySelectorAll('thead th');
      for (const { kind, label } of COPYNAME_COLS) {
        const idx = headerIndex(table, label);
        if (idx < 0) continue;
        const th = ths[idx];
        if (!th || th.querySelector('button[data-qsb-copy]')) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qsb-copy-btn qsb-copy-btn--th';
        btn.dataset.qsbCopy = kind;
        btn.textContent = COPYNAME_LABEL;
        btn.title = `复制全页所有「启用」表的${label}；Alt+点击只复制本表`;
        th.appendChild(btn);
      }
    }
  }

  /** 一张嵌套表 → 启用行的 { cn, en }（列按表头文字定位） */
  function enabledTableRows(table) {
    const cnIdx = headerIndex(table, '表中文名称');
    const enIdx = headerIndex(table, '表英文名称');
    const stateIdx = headerIndex(table, ENABLED_COL_LABEL);
    const rows = [];
    for (const row of table.querySelectorAll('tbody tr.ant-table-row')) {
      const cells = row.querySelectorAll('td');
      if (stateIdx >= 0 && readEnabledState(cells[stateIdx]) === false) continue;
      const cn = cnIdx >= 0 && cells[cnIdx] ? (cells[cnIdx].textContent || '').trim() : '';
      const en = enIdx >= 0 && cells[enIdx] ? (cells[enIdx].textContent || '').trim() : '';
      if (!cn && !en) continue;
      rows.push({ cn, en });
    }
    return rows;
  }

  function flashExportAll(link, text, busy, restoreMs) {
    clearTimeout(link._qsbExportTimer);
    link.textContent = text;
    link.dataset.qsbBusy = busy ? '1' : '';
    if (restoreMs) {
      link._qsbExportTimer = setTimeout(() => {
        if (link.isConnected === false) return;
        link.textContent = EXPORT_COL_LABEL;
        link.dataset.qsbBusy = '';
      }, restoreMs);
    }
  }

  /**
   * 表头「导出Excel」：一个连接器的启用表 → 一个 xlsx，每张表一个 sheet。
   * 表定义一次拿全（getConnectorTables 只发一次 conn/mapper/get），再按表名挑选，
   * 所以 13 张表也只打 1 个请求。
   */
  async function exportEnabledTables(link) {
    const table = link.closest('table');
    const owner = table ? findOwnerRow(table) : { id: '', name: '' };
    const rows = table ? enabledTableRows(table) : [];
    if (!rows.length) {
      flashExportAll(link, '无启用表');
      return;
    }

    flashExportAll(link, '导出中…', true);
    try {
      const tables = await getConnectorTables(owner.name, owner.id);
      const sheets = [];
      const usedNames = new Set();
      const missing = [];
      for (const row of rows) {
        const def = pickTable(tables, row.en, row.cn);
        const fields = def && Array.isArray(def.fields) ? def.fields : [];
        if (!fields.length) { missing.push(row.cn || row.en); continue; }
        sheets.push({
          name: uniqueSheetName(def.tableNameCn || row.cn || def.tableNameEn, usedNames),
          block: {
            connectorName: owner.name || '',
            tableNameCn: def.tableNameCn || row.cn,
            tableNameEn: def.tableNameEn || row.en,
            rows: fields.map(f => [f.fieldName, f.fieldComment, f.fieldAttr, f.fieldLength])
          }
        });
      }

      if (missing.length) console.warn(LOG_TAG, '批量导出：以下启用表未取到字段，已跳过', missing);
      if (!sheets.length) {
        console.warn(LOG_TAG, '批量导出：启用表全部取不到字段定义', { connector: owner.name, rows });
        flashExportAll(link, '未取到字段', false, 2500);
        return;
      }

      downloadXlsx(buildWorkbook(sheets), `${toFileNamePart(owner.name || 'ETL配置')}.xlsx`);
      flashExportAll(link,
        missing.length ? `已导出 ${sheets.length} 表（跳过 ${missing.length}）` : `已导出 ${sheets.length} 表`,
        false, 2500);
    } catch (err) {
      console.warn(LOG_TAG, '批量导出失败:', err);
      flashExportAll(link, '导出失败', false, 2500);
    }
  }

  function onDataCenterClick(e) {
    const target = e.target;
    const copyBtn = target.closest && target.closest('button[data-qsb-copy]');
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();        // 别让 antd 的头/行点击逻辑跟着响应
      handleCopyNameClick(copyBtn, e.altKey ? copyBtn.closest('table') : null);
      return;
    }

    const exportAll = target.closest && target.closest('.qsb-export-all');
    if (exportAll) {
      e.preventDefault();
      e.stopPropagation();
      if (exportAll.dataset.qsbBusy === '1') return;
      exportEnabledTables(exportAll);
      return;
    }

    const btn = target.closest && target.closest('.qsb-export-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();          // 别让 antd 的行点击/展开逻辑跟着响应
    if (btn.dataset.qsbBusy === '1') return;
    exportTable(btn);
  }

  registerPage({
    name: 'dataCenter',
    route: DATA_CENTER_ROUTE,
    setup(state) {
      // enterPage 在同一路由内会被重复调用，这里必须幂等
      if (!state.exportReady) {
        state.exportReady = true;
        document.addEventListener('click', onDataCenterClick, true);
        if (!exportObserver) {
          exportObserver = new MutationObserver(() => {
            clearTimeout(exportInjectTimer);
            exportInjectTimer = setTimeout(() => {
              injectExportColumns();
              injectCopyNameButtons();
            }, 300);
          });
          exportObserver.observe(document.body, { childList: true, subtree: true });
        }
        console.log(LOG_TAG, '数据中心：导出列 + 启用表名复制已接管');
      }
      injectExportColumns();
      injectCopyNameButtons();
    },
    teardown(state) {
      state.exportReady = false;
      document.removeEventListener('click', onDataCenterClick, true);
      clearTimeout(exportInjectTimer);
      if (exportObserver) { exportObserver.disconnect(); exportObserver = null; }
      tableDefCache.clear();
      document.querySelectorAll('[data-qsb-export], button[data-qsb-copy], .qsb-copy-panel')
        .forEach(el => el.remove());
    }
  });

  // 先装拦截器：SPA 进入目标页时首个列表请求可能早于路由回调
  ensureInterceptor();

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(start, 500);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(start, 500));
  }

})();
