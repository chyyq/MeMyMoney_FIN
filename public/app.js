const STORAGE_KEY = "me-my-money-static-state";
const API_TIMEOUT_MS = 7000;
const SNAPSHOT_TIMEOUT_MS = 5000;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STRATEGY_BASE_EQUITY = 3912;

const STRATEGY_MODULES = [
  {
    id: "core",
    name: "AI核心趋势仓",
    targetPercent: 40,
    baseAmount: 1560,
    risk: "中",
    purpose: "只押AI基础设施龙头，不频繁换股"
  },
  {
    id: "aggressive",
    name: "高弹性进攻仓",
    targetPercent: 30,
    baseAmount: 1170,
    risk: "高",
    purpose: "市场情绪、高β资产和AI延伸链放大收益"
  },
  {
    id: "short",
    name: "超短线交易仓",
    targetPercent: 20,
    baseAmount: 780,
    risk: "很高",
    purpose: "1天到15天滚动，杠杆ETF不长期持有"
  },
  {
    id: "cash",
    name: "机动现金",
    targetPercent: 10,
    baseAmount: 402,
    risk: "低",
    purpose: "黑天鹅、恐慌回调和短线失败后的补救资金"
  }
];

const STRATEGY_RULES = [
  {
    symbol: "NVDA",
    moduleId: "core",
    baseAmount: 900,
    buyZone: [210, 230],
    targets: [270, 300, 330],
    stop: 190,
    horizon: "3-12个月",
    stopPercent: 12,
    targetReturn: [15, 30],
    thesis: "AI基础设施核心龙头，趋势仓分三批，不追涨满仓"
  },
  {
    symbol: "MSFT",
    moduleId: "core",
    baseAmount: 660,
    buyZone: [410, 430],
    targets: [500, 560],
    horizon: "6-18个月",
    stopPercent: 10,
    targetReturn: [12, 25],
    thesis: "AI云和企业软件的稳定底仓，承担组合压舱石"
  },
  {
    symbol: "AMD",
    moduleId: "aggressive",
    baseAmount: 400,
    buyZone: [150, 165],
    targets: [190, 220],
    horizon: "1-6个月",
    stopPercent: 10,
    targetReturn: [18, 34],
    thesis: "AI第二梯队，主要博弈NVDA周期后的补涨"
  },
  {
    symbol: "ARM",
    moduleId: "aggressive",
    baseAmount: 300,
    pullbackPercent: [5, 10],
    targetReturn: [20, 40],
    horizon: "1-4个月",
    stopPercent: 11,
    thesis: "AI芯片架构链，高估值下只吃回调后的弹性"
  },
  {
    symbol: "PLTR",
    moduleId: "aggressive",
    baseAmount: 300,
    pullbackPercent: [12, 15],
    targetReturn: [20, 35],
    horizon: "1-6个月",
    stopPercent: 12,
    thesis: "AI软件情绪龙头，用新高后的延续性确认卖点"
  },
  {
    symbol: "TSLA",
    moduleId: "aggressive",
    baseAmount: 170,
    pullbackPercent: [6, 12],
    targetReturn: [15, 30],
    horizon: "2-8周",
    stopPercent: 9,
    thesis: "情绪与波动工具，只在低位区间或放量恐慌后参与"
  },
  {
    symbol: "SOXL",
    moduleId: "short",
    tradeAmount: [200, 300],
    targetReturn: [10, 25],
    horizon: "1-15天",
    stopPercent: 7,
    thesis: "三倍半导体ETF，只做VIX上行但未恐慌后的反弹"
  },
  {
    symbol: "TQQQ",
    moduleId: "short",
    tradeAmount: [200, 300],
    targetReturn: [8, 18],
    horizon: "1-15天",
    stopPercent: 6,
    thesis: "三倍纳指ETF，只在纳指回调2%-4%后顺势滚动"
  },
  {
    symbol: "TSLL",
    moduleId: "short",
    tradeAmount: [200, 300],
    targetReturn: [8, 20],
    horizon: "1-10天",
    stopPercent: 8,
    thesis: "两倍TSLA，只做情绪波动，不长期持有"
  }
];

const STRATEGY_SYMBOLS = STRATEGY_RULES.map((item) => item.symbol);
const WATCHLIST = uniqueSymbols([...STRATEGY_SYMBOLS, "QQQ", "SPY"]);
const MODULE_BY_ID = new Map(STRATEGY_MODULES.map((item) => [item.id, item]));
const RULE_BY_SYMBOL = new Map(STRATEGY_RULES.map((item) => [item.symbol, item]));

const state = {
  dashboard: null,
  apiMode: false,
  refreshTimer: null
};

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const signedMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  signDisplay: "always"
});

document.addEventListener("DOMContentLoaded", () => {
  const today = new Date().toISOString().slice(0, 10);
  $("#tradeForm [name='date']").value = today;
  $("#recordButton").addEventListener("click", () => openDialog("recordDialog"));
  $("#holdingButton").addEventListener("click", () => openDialog("holdingDialog"));
  $("#refreshButton").addEventListener("click", () => loadDashboard({ force: true }));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
  });
  $("#tradeForm").addEventListener("submit", saveTrade);
  $("#holdingForm").addEventListener("submit", saveHolding);
  $("#accountForm").addEventListener("submit", saveAccount);
  $("#holdingList").addEventListener("click", handleHoldingListClick);
  $("#tradeList").addEventListener("click", handleTradeListClick);
  loadDashboard();
  state.refreshTimer = window.setInterval(() => {
    if (!document.hidden) loadDashboard({ silent: true });
  }, AUTO_REFRESH_MS);
});

async function loadDashboard(options = {}) {
  $("#refreshButton").disabled = true;
  try {
    const savedState = readState();
    const liveData = await fetchLiveDashboard();
    const snapshot = liveData ? null : await fetchDailySnapshot();
    state.apiMode = Boolean(liveData);

    const dataState = liveData
      ? normalizeExternalState(liveData)
      : savedState;
    const symbols = uniqueSymbols([
      ...WATCHLIST,
      ...dataState.holdings.map((item) => item.symbol)
    ]);
    const quotes = completeQuotes(symbols, liveData?.quotes || snapshot?.quotes || []);
    const holdings = enrichHoldings(dataState.holdings, quotes);
    const sources = prioritizeSources(liveData?.sources || snapshot?.sources || sampleSources());
    const strategy = scoreStrategy({
      account: dataState.account,
      trades: dataState.trades,
      holdings,
      quotes,
      sources,
      dataMode: liveData ? "live" : snapshot ? "snapshot" : "sample"
    });

    const data = {
      asOf: liveData?.asOf || snapshot?.asOf || new Date().toISOString(),
      account: dataState.account,
      holdings,
      trades: dataState.trades.slice(0, 30),
      quotes,
      sources,
      strategy,
      providers: buildProviderStatus(liveData, snapshot, quotes, sources)
    };

    state.dashboard = data;
    renderDashboard(data);
    if (options.force) toast(liveData ? "已刷新实时数据。" : snapshot ? "已读取每日快照。" : "实时源暂不可用，已使用内置样本。");
  } catch (error) {
    console.error(error);
    toast("刷新失败，页面已保留上一次可用数据。");
  } finally {
    $("#refreshButton").disabled = false;
  }
}

function renderDashboard(data) {
  const { account, strategy, holdings, trades, sources, providers } = data;
  const primary = strategy.primary;

  $("#conclusionText").textContent = strategy.conclusion;
  $("#primarySymbol").textContent = primary.symbol;
  $("#primaryAction").textContent = primary.actionLabel || actionText(primary.direction);
  $("#confidence").textContent = `${strategy.portfolioScore}/100`;
  $("#primaryReason").textContent = primary.reason;
  $("#positionInsight").textContent = strategy.positionInsight;
  $("#entryPrice").textContent = formatWindow(primary.entryWindow);
  $("#stopPrice").textContent = formatPrice(primary.stop);
  $("#targetPrice").textContent = formatWindow(primary.targetWindow);
  $("#riskBudget").textContent = money.format(strategy.riskBudget || 0);

  $("#equityValue").textContent = money.format(account.equity || 0);
  $("#dayPnl").textContent = `日内 ${signedMoney.format(account.dayPnl || 0)}`;
  $("#totalPnl").textContent = `累计 ${signedMoney.format(account.totalPnl || 0)}`;
  $("#dayPnl").className = Number(account.dayPnl) >= 0 ? "profit" : "loss";
  $("#totalPnl").className = Number(account.totalPnl) >= 0 ? "profit" : "loss";

  $("#accountForm [name='equity']").value = account.equity ?? "";
  $("#accountForm [name='cash']").value = account.cash ?? "";
  $("#accountForm [name='riskPerTrade']").value = account.riskPerTrade ?? "";

  renderPrioritySignal(strategy.serenitySignal);
  renderModules(strategy.modules);
  renderHoldingSummary(holdings);
  renderHoldings(holdings);
  renderCandidates(strategy.candidates);
  renderTrades(trades);
  renderSources(sources);
  renderProviders(providers, data.asOf, strategy.dataQuality);
}

function renderPrioritySignal(signal) {
  const node = $("#prioritySignal");
  if (!signal) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  const href = safeUrl(signal.url);
  node.hidden = false;
  node.innerHTML = `
    <div>
      <strong>Serenity 优先信号</strong>
      <p>${escapeHtml(signal.summary || signal.title || "已捕捉到新的优先来源。")}</p>
      <p class="muted">${escapeHtml(signal.symbols?.length ? `关联标的：${signal.symbols.join(", ")}` : "未提及明确代码，先作为情绪来源观察")} · ${formatDate(signal.publishedAt)}</p>
    </div>
    ${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">查看</a>` : `<span class="disabled-link">无链接</span>`}
  `;
}

function renderModules(modules) {
  $("#strategyModules").innerHTML = modules.map((item) => `
    <div class="module-pill">
      <strong>${escapeHtml(item.name)}</strong>
      <span>目标 ${formatPercent(item.targetPercent)} · 当前 ${formatPercent(item.currentPercent)} · ${escapeHtml(item.status)}</span>
    </div>
  `).join("");
}

function renderHoldingSummary(holdings) {
  const summary = summarizeHoldings(holdings);
  $("#holdingCount").textContent = `${holdings.length} 只`;
  $("#holdingExposure").textContent = money.format(summary.marketValue);
  $("#holdingPnl").textContent = signedMoney.format(summary.unrealizedPnl);
  $("#holdingPnl").className = summary.unrealizedPnl >= 0 ? "profit" : "loss";
}

function renderHoldings(holdings) {
  if (!holdings.length) {
    $("#holdingList").innerHTML = `
      <div class="empty-state">
        <strong>还没有持仓。</strong>
        <p>点击“记录持仓”添加股票、数量和成本价，系统会把持仓盈亏、实时涨跌与买卖窗口纳入组合结论。</p>
      </div>
    `;
    return;
  }

  $("#holdingList").innerHTML = holdings.map((holding) => {
    const pnlClass = holding.unrealizedPnl >= 0 ? "profit" : "loss";
    const dayClass = Number(holding.dayChangePercent) >= 0 ? "profit" : "loss";
    return `
      <article class="holding-card">
        <div class="holding-main">
          <div class="symbol-chip">${escapeHtml(holding.symbol)}</div>
          <div>
            <h3>${escapeHtml(holding.symbol)} · ${escapeHtml(holding.status)}</h3>
            <p>${formatShares(holding.shares)} 股 · 成本 ${formatPrice(holding.averageCost)} · 现价 ${formatPrice(holding.currentPrice)} <span class="${dayClass}">${formatPercent(holding.dayChangePercent)}</span></p>
            ${holding.thesis ? `<p class="muted">${escapeHtml(holding.thesis)}</p>` : ""}
          </div>
        </div>
        <div class="holding-metrics">
          <span>市值 <b>${money.format(holding.marketValue)}</b></span>
          <span class="${pnlClass}">浮盈亏 <b>${signedMoney.format(holding.unrealizedPnl)}</b> (${formatPercent(holding.pnlPercent)})</span>
          <span>买入窗口 <b>${formatWindow(holding.buyWindow)}</b></span>
          <span>卖出窗口 <b>${formatWindow(holding.sellWindow)}</b></span>
          <span>止损点 <b>${formatPrice(holding.protectiveStop)}</b></span>
          <span>报价 <b>${escapeHtml(holding.quoteSource)}</b></span>
        </div>
        <button class="text-button danger-button" type="button" data-action="remove-holding" data-symbol="${escapeHtml(holding.symbol)}">删除</button>
      </article>
    `;
  }).join("");
}

function renderCandidates(candidates) {
  $("#candidates").innerHTML = candidates.map((item) => {
    const holdingLine = item.holding
      ? `<p class="muted">现有持仓 ${formatShares(item.holding.shares)} 股 · 浮盈亏 ${signedMoney.format(item.holding.unrealizedPnl)} (${formatPercent(item.holding.pnlPercent)}) · ${escapeHtml(item.holding.status)}</p>`
      : "";
    const sourceLine = item.prioritySource
      ? `Serenity 优先来源 · 相关来源 ${item.sourceCount} 条`
      : `相关来源 ${item.sourceCount} 条`;
    return `
      <article class="candidate">
        <div class="symbol-chip">${escapeHtml(item.symbol)}</div>
        <div>
          <h3>${escapeHtml(item.actionLabel)} · ${escapeHtml(item.symbol)}</h3>
          <p>${escapeHtml(item.reason)}</p>
          <p class="muted">模块 ${escapeHtml(item.moduleName)} · ${escapeHtml(item.allocationText)} · 预估时间 ${escapeHtml(item.horizon)}</p>
          <p class="muted">买点 ${formatWindow(item.entryWindow)} · 卖点 ${formatWindow(item.targetWindow)} · 止损 ${formatPrice(item.stop)}</p>
          <p class="muted">${escapeHtml(item.windowState)} · ${escapeHtml(sourceLine)}</p>
          ${holdingLine}
        </div>
        <div class="score-ring">${item.score}</div>
      </article>
    `;
  }).join("");
}

function renderTrades(trades) {
  if (!trades.length) {
    $("#tradeList").innerHTML = `<div class="trade"><p>还没有执行记录。点击右上角“记录执行”开始积累自己的策略反馈。</p></div>`;
    return;
  }
  $("#tradeList").innerHTML = trades.map((trade) => {
    const netPnl = Number(trade.pnl || 0) - Number(trade.fees || 0);
    const pnlClass = netPnl >= 0 ? "profit" : "loss";
    return `
      <article class="trade">
        <div>
          <h3>${escapeHtml(trade.symbol)} · ${trade.side === "BUY" ? "买入" : "卖出/做空"}</h3>
          <p>${escapeHtml(trade.date)} · 数量 ${formatShares(trade.size)} · 入场 ${formatPrice(trade.entry)} · 出场 ${formatPrice(trade.exit)}</p>
          ${trade.notes ? `<p class="muted">${escapeHtml(trade.notes)}</p>` : ""}
        </div>
        <div class="trade-actions">
          <strong class="${pnlClass}">${signedMoney.format(netPnl)}</strong>
          <button class="text-button danger-button" type="button" data-action="remove-trade" data-id="${escapeHtml(trade.id)}">删除</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderSources(sources) {
  $("#sources").innerHTML = sources.slice(0, 20).map((item) => {
    const href = safeUrl(item.url);
    const priority = isSerenitySource(item) ? `<span class="source-badge">Serenity优先</span>` : "";
    return `
      <article class="source">
        <div>
          <h3>${escapeHtml(item.title || "未命名来源")} ${priority}</h3>
          <p>${escapeHtml(item.summary || "")}</p>
          <p class="muted">${escapeHtml(item.provider || item.type || "source")} · ${formatDate(item.publishedAt)}${item.symbols?.length ? ` · ${escapeHtml(item.symbols.join(", "))}` : ""}</p>
        </div>
        ${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">查看</a>` : `<span class="disabled-link">无链接</span>`}
      </article>
    `;
  }).join("");
}

function renderProviders(providers, asOf, dataQuality) {
  const items = {
    更新时间: formatDate(asOf),
    数据质量: `${dataQuality.label} ${dataQuality.score}/100`,
    ...providers
  };
  $("#providerStatus").innerHTML = Object.entries(items).map(([name, value]) =>
    `<span>${escapeHtml(name)}: ${escapeHtml(value)}</span>`
  ).join("");
}

async function saveTrade(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const trade = normalizeTrade(Object.fromEntries(new FormData(form).entries()));
  try {
    if (state.apiMode) {
      await apiRequest("/api/trades", { method: "POST", body: JSON.stringify(trade) });
    } else {
      const savedState = readState();
      savedState.trades.unshift(trade);
      savedState.account = updateAccountFromTrade(savedState.account, trade);
      writeState(savedState);
    }
    closeDialog("recordDialog");
    form.reset();
    $("#tradeForm [name='date']").value = new Date().toISOString().slice(0, 10);
    toast("执行结果已保存。");
    await loadDashboard({ silent: true });
  } catch {
    const savedState = readState();
    savedState.trades.unshift(trade);
    savedState.account = updateAccountFromTrade(savedState.account, trade);
    writeState(savedState);
    state.apiMode = false;
    closeDialog("recordDialog");
    form.reset();
    toast("实时服务暂不可用，记录已保存在浏览器本地。");
    await loadDashboard({ silent: true });
  }
}

async function saveHolding(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const holding = normalizeHolding(Object.fromEntries(new FormData(form).entries()));
  try {
    if (state.apiMode) {
      await apiRequest("/api/holdings", { method: "POST", body: JSON.stringify(holding) });
    } else {
      const savedState = readState();
      const nextHoldings = savedState.holdings.filter((item) => item.symbol !== holding.symbol);
      savedState.holdings = [holding, ...nextHoldings].sort((a, b) => a.symbol.localeCompare(b.symbol));
      writeState(savedState);
    }
    closeDialog("holdingDialog");
    form.reset();
    toast(`${holding.symbol} 持仓已更新。`);
    await loadDashboard({ silent: true });
  } catch {
    const savedState = readState();
    const nextHoldings = savedState.holdings.filter((item) => item.symbol !== holding.symbol);
    savedState.holdings = [holding, ...nextHoldings].sort((a, b) => a.symbol.localeCompare(b.symbol));
    writeState(savedState);
    state.apiMode = false;
    closeDialog("holdingDialog");
    form.reset();
    toast("实时服务暂不可用，持仓已保存在浏览器本地。");
    await loadDashboard({ silent: true });
  }
}

async function saveAccount(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const accountPatch = {
    ...pickNumbers(payload, ["cash", "equity", "riskPerTrade"]),
    updatedAt: new Date().toISOString()
  };
  try {
    if (state.apiMode) {
      await apiRequest("/api/account", { method: "PUT", body: JSON.stringify(accountPatch) });
    } else {
      const savedState = readState();
      savedState.account = { ...savedState.account, ...accountPatch };
      writeState(savedState);
    }
    toast("账户已更新。");
    await loadDashboard({ silent: true });
  } catch {
    const savedState = readState();
    savedState.account = { ...savedState.account, ...accountPatch };
    writeState(savedState);
    state.apiMode = false;
    toast("实时服务暂不可用，账户已保存在浏览器本地。");
    await loadDashboard({ silent: true });
  }
}

async function handleHoldingListClick(event) {
  const button = event.target.closest("[data-action='remove-holding']");
  if (!button) return;
  const symbol = button.dataset.symbol;
  if (!window.confirm(`确定删除 ${symbol} 持仓吗？`)) return;
  try {
    if (state.apiMode) {
      await apiRequest(`/api/holdings/${encodeURIComponent(symbol)}`, { method: "DELETE" });
    } else {
      const savedState = readState();
      savedState.holdings = savedState.holdings.filter((item) => item.symbol !== symbol);
      writeState(savedState);
    }
    toast(`${symbol} 持仓已删除。`);
    await loadDashboard({ silent: true });
  } catch {
    toast("删除失败，请稍后重试。");
  }
}

async function handleTradeListClick(event) {
  const button = event.target.closest("[data-action='remove-trade']");
  if (!button) return;
  const id = button.dataset.id;
  if (!window.confirm("确定删除这条执行记录吗？")) return;
  try {
    if (state.apiMode) {
      await apiRequest(`/api/trades/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else {
      const savedState = readState();
      const removed = savedState.trades.find((item) => item.id === id);
      savedState.trades = savedState.trades.filter((item) => item.id !== id);
      if (removed) savedState.account = rollbackAccountFromTrade(savedState.account, removed);
      writeState(savedState);
    }
    toast("执行记录已删除。");
    await loadDashboard({ silent: true });
  } catch {
    toast("删除失败，请稍后重试。");
  }
}

async function fetchLiveDashboard() {
  if (!["http:", "https:"].includes(window.location.protocol)) return null;
  try {
    const response = await fetchWithTimeout("/api/dashboard", { cache: "no-store" }, API_TIMEOUT_MS);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function fetchDailySnapshot() {
  if (!["http:", "https:"].includes(window.location.protocol)) return null;
  try {
    const response = await fetchWithTimeout(`./data/market-snapshot.json?ts=${Date.now()}`, { cache: "no-store" }, SNAPSHOT_TIMEOUT_MS);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null;
    return response.json();
  } catch {
    return null;
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timer));
}

async function apiRequest(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  }, API_TIMEOUT_MS);
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}

function normalizeExternalState(data) {
  return {
    account: normalizeAccount(data.account || defaultState().account),
    holdings: Array.isArray(data.holdings) ? data.holdings.map(normalizeHolding).filter((item) => item.shares > 0) : [],
    trades: Array.isArray(data.trades) ? data.trades.map(normalizeTrade) : []
  };
}

function readState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && parsed.account && Array.isArray(parsed.trades)) {
      return {
        ...defaultState(),
        ...parsed,
        account: normalizeAccount(parsed.account),
        trades: parsed.trades.map(normalizeTrade),
        holdings: Array.isArray(parsed.holdings) ? parsed.holdings.map(normalizeHolding).filter((item) => item.shares > 0) : []
      };
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return defaultState();
}

function writeState(nextState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
}

function defaultState() {
  return {
    account: {
      cash: 3912,
      equity: 3912,
      dayPnl: 0,
      totalPnl: 0,
      riskPerTrade: 1.2,
      updatedAt: new Date().toISOString()
    },
    holdings: [],
    trades: [],
    watchlist: WATCHLIST
  };
}

function normalizeAccount(input) {
  return {
    cash: Number(input.cash ?? 3912),
    equity: Number(input.equity ?? input.cash ?? 3912),
    dayPnl: Number(input.dayPnl || 0),
    totalPnl: Number(input.totalPnl || 0),
    riskPerTrade: Number(input.riskPerTrade || 1.2),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function updateAccountFromTrade(account, trade) {
  const delta = Number(trade.pnl || 0) - Number(trade.fees || 0);
  return {
    ...account,
    cash: round(Number(account.cash || 0) + delta),
    equity: round(Number(account.equity || 0) + delta),
    dayPnl: round(Number(account.dayPnl || 0) + delta),
    totalPnl: round(Number(account.totalPnl || 0) + delta),
    updatedAt: new Date().toISOString()
  };
}

function rollbackAccountFromTrade(account, trade) {
  const delta = Number(trade.pnl || 0) - Number(trade.fees || 0);
  return {
    ...account,
    cash: round(Number(account.cash || 0) - delta),
    equity: round(Number(account.equity || 0) - delta),
    dayPnl: round(Number(account.dayPnl || 0) - delta),
    totalPnl: round(Number(account.totalPnl || 0) - delta),
    updatedAt: new Date().toISOString()
  };
}

function normalizeTrade(input) {
  const side = String(input.side || "BUY").toUpperCase();
  return {
    id: input.id || (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    date: input.date || new Date().toISOString().slice(0, 10),
    symbol: String(input.symbol || "SPY").toUpperCase().trim(),
    side: side === "SELL" ? "SELL" : "BUY",
    entry: Number(input.entry || 0),
    exit: Number(input.exit || 0),
    size: Number(input.size || 0),
    pnl: Number(input.pnl || 0),
    fees: Number(input.fees || 0),
    notes: String(input.notes || "").trim(),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function normalizeHolding(input) {
  return {
    id: input.id || String(input.symbol || "SPY").toUpperCase().trim(),
    symbol: String(input.symbol || "SPY").toUpperCase().trim(),
    shares: Number(input.shares || input.size || 0),
    averageCost: Number(input.averageCost || input.entry || 0),
    thesis: String(input.thesis || input.notes || "").trim(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function enrichHoldings(holdings, quotes) {
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  return holdings.map((holding) => {
    const quote = quoteBySymbol.get(holding.symbol) || {};
    const currentPrice = Number(quote.price || holding.currentPrice || holding.averageCost || 0);
    const marketValue = round(holding.shares * currentPrice);
    const costBasis = round(holding.shares * holding.averageCost);
    const unrealizedPnl = round(marketValue - costBasis);
    const pnlPercent = costBasis ? round(unrealizedPnl / costBasis * 100) : 0;
    const rule = RULE_BY_SYMBOL.get(holding.symbol) || defaultRule(holding.symbol);
    const plan = buildRulePlan(rule, currentPrice, quote, holding);
    return {
      ...holding,
      currentPrice,
      marketValue,
      costBasis,
      unrealizedPnl,
      pnlPercent,
      dayChangePercent: Number(quote.changePercent || 0),
      status: holdingStatus(pnlPercent, Number(quote.changePercent || 0), currentPrice, plan.stop, plan.targetWindow),
      buyWindow: plan.entryWindow,
      sellWindow: plan.targetWindow,
      protectiveStop: plan.stop,
      quoteSource: quote.source || "Manual"
    };
  }).sort((a, b) => Math.abs(b.unrealizedPnl) - Math.abs(a.unrealizedPnl));
}

function scoreStrategy({ account, trades, holdings, quotes, sources, dataMode }) {
  const equity = Number(account.equity || STRATEGY_BASE_EQUITY);
  const recentTrades = trades.slice(0, 30);
  const hitRate = recentTrades.length
    ? recentTrades.filter((trade) => Number(trade.pnl) > 0).length / recentTrades.length
    : 0.56;
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const holdingBySymbol = new Map(holdings.map((holding) => [holding.symbol, holding]));
  const symbols = uniqueSymbols([...STRATEGY_SYMBOLS, ...holdings.map((holding) => holding.symbol)]);

  const candidates = symbols.map((symbol) => {
    const rule = RULE_BY_SYMBOL.get(symbol) || defaultRule(symbol);
    const quote = quoteBySymbol.get(symbol) || {};
    const holding = holdingBySymbol.get(symbol);
    const price = Number(quote.price || holding?.currentPrice || holding?.averageCost || 0);
    const sourceHits = sourceHitsFor(symbol, sources);
    const prioritySource = sourceHits.find(isSerenitySource);
    const plan = buildRulePlan(rule, price, quote, holding);
    const allocation = allocationFor(rule, equity, holding);
    const momentum = Number(quote.changePercent || holding?.dayChangePercent || 0);
    const sourceScore = sourceHits.reduce((sum, item) => sum + Number(item.sentiment || 0), 0) * 4
      + Math.min(sourceHits.length * 2, 8)
      + (prioritySource ? 22 : 0);
    const moduleScore = rule.moduleId === "core" ? 10 : rule.moduleId === "aggressive" ? 8 : rule.moduleId === "short" ? 6 : 2;
    const allocationScore = allocation.gapPercent > 2 ? 4 : allocation.gapPercent < -3 ? -4 : 1;
    const holdingScore = holding ? holdingSignalScore(holding, plan, momentum) : 0;
    const momentumScore = rule.moduleId === "short"
      ? clamp(momentum * 1.4, -8, 9)
      : clamp(momentum * 1.2, -7, 8);
    const qualityPenalty = dataMode === "sample" ? -5 : dataMode === "snapshot" ? -1 : 2;
    const score = clamp(Math.round(
      45
      + moduleScore
      + plan.setupScore
      + sourceScore
      + momentumScore
      + allocationScore
      + holdingScore
      + (hitRate - 0.5) * 10
      + qualityPenalty
    ), 5, 96);
    const direction = decideDirection({ score, holding, price, plan, rule });
    return {
      symbol,
      direction,
      actionLabel: actionText(direction),
      score,
      entryWindow: plan.entryWindow,
      stop: plan.stop,
      targetWindow: plan.targetWindow,
      sourceCount: sourceHits.length,
      prioritySource,
      holding,
      moduleName: MODULE_BY_ID.get(rule.moduleId)?.name || "观察池",
      allocationText: allocation.text,
      allocationGap: allocation.gap,
      horizon: rule.horizon || "按价格确认",
      windowState: plan.windowState,
      reason: buildReason(direction, momentum, sourceHits.length, hitRate, holding, rule, plan, prioritySource)
    };
  });

  candidates.sort((a, b) => {
    if (Boolean(b.prioritySource) !== Boolean(a.prioritySource)) return Number(Boolean(b.prioritySource)) - Number(Boolean(a.prioritySource));
    return b.score - a.score;
  });
  const serenitySignal = findSerenitySignal(sources);
  const primary = selectPrimary(candidates, serenitySignal);
  const modules = buildModuleStatus(holdings, equity, account.cash);
  const maxRisk = round(Math.max(equity * Number(account.riskPerTrade || 1) / 100, 0));
  const dataQuality = buildDataQuality(quotes, sources, dataMode);
  const portfolioScore = clamp(Math.round(
    primary.score * 0.72
    + dataQuality.score * 0.18
    + Math.min(modules.filter((item) => item.status !== "偏离较大").length * 2, 10)
  ), 5, 98);
  return {
    primary,
    candidates,
    modules,
    confidence: primary.score,
    portfolioScore,
    riskBudget: maxRisk,
    serenitySignal,
    dataQuality,
    positionInsight: positionInsightText(holdings, modules, dataQuality),
    conclusion: conclusionText(primary, maxRisk, dataQuality, serenitySignal)
  };
}

function buildRulePlan(rule, price, quote, holding) {
  if (!price) {
    return {
      entryWindow: null,
      targetWindow: null,
      stop: null,
      setupScore: -8,
      windowState: "缺少报价，暂不生成交易窗口"
    };
  }
  const entryWindow = computeEntryWindow(rule, price, quote);
  const targetWindow = computeTargetWindow(rule, price, entryWindow);
  const stop = computeStop(rule, price);
  const inEntry = isInRange(price, entryWindow);
  const inTarget = targetWindow && price >= targetWindow[0];
  const belowStop = stop && price <= stop;
  const nearEntry = entryWindow && price > entryWindow[1] && price <= entryWindow[1] * 1.035;
  const belowEntry = entryWindow && price < entryWindow[0];
  let setupScore = 0;
  let windowState = "等待价格进入更理想的风险收益区";
  if (belowStop) {
    setupScore = -24;
    windowState = "已触及或跌破止损点，先保护本金";
  } else if (inTarget) {
    setupScore = holding ? 8 : -4;
    windowState = "接近卖出窗口，适合分批兑现或上移止损";
  } else if (inEntry) {
    setupScore = 18;
    windowState = "处在买入窗口，允许按计划分批";
  } else if (nearEntry) {
    setupScore = 6;
    windowState = "略高于理想买点，等回踩或放量确认";
  } else if (belowEntry) {
    setupScore = rule.moduleId === "short" ? -5 : 3;
    windowState = "低于买入窗口，需等重新转强再动手";
  } else {
    setupScore = -3;
  }
  return { entryWindow, targetWindow, stop, setupScore, windowState };
}

function computeEntryWindow(rule, price, quote) {
  if (rule.buyZone && rangeUsable(rule.buyZone, price, 0.28)) return rule.buyZone;
  if (rule.pullbackPercent) {
    const [light, deep] = rule.pullbackPercent;
    return normalizeRange([price * (1 - deep / 100), price * (1 - light / 100)]);
  }
  if (rule.moduleId === "short") {
    const change = Number(quote.changePercent || 0);
    const lower = change <= -2 ? 0.985 : 0.955;
    const upper = change <= -2 ? 1.006 : 0.99;
    return normalizeRange([price * lower, price * upper]);
  }
  return normalizeRange([price * 0.965, price * 0.995]);
}

function computeTargetWindow(rule, price, entryWindow) {
  const targetRange = Array.isArray(rule.targets) ? [Math.min(...rule.targets), Math.max(...rule.targets)] : null;
  if (targetRange && rangeUsable(targetRange, price, 0.42)) return normalizeRange(targetRange);
  const [low, high] = rule.targetReturn || [8, 18];
  const base = entryWindow ? Math.max(price, entryWindow[1]) : price;
  return normalizeRange([base * (1 + low / 100), base * (1 + high / 100)]);
}

function computeStop(rule, price) {
  if (rule.stop && rule.stop < price && rule.stop > price * 0.62) return round(rule.stop);
  return round(price * (1 - Number(rule.stopPercent || 9) / 100));
}

function decideDirection({ score, holding, price, plan, rule }) {
  if (price && plan.stop && price <= plan.stop) return "STOP";
  if (price && plan.targetWindow && price >= plan.targetWindow[0]) return holding ? "TRIM" : "WAIT";
  if (score >= 66 && isInRange(price, plan.entryWindow)) return holding ? "ADD" : "BUY";
  if (score >= 72 && rule.moduleId !== "short") return holding ? "HOLD" : "BUY";
  if (holding) return "HOLD";
  return "WAIT";
}

function selectPrimary(candidates, serenitySignal) {
  const stopCandidate = candidates.find((item) => item.direction === "STOP");
  if (stopCandidate) return stopCandidate;
  if (serenitySignal?.symbols?.length) {
    const priority = candidates.find((item) => serenitySignal.symbols.includes(item.symbol));
    if (priority) return priority;
  }
  const positionCandidate = candidates
    .filter((item) => item.holding)
    .sort((a, b) => Math.abs(b.holding.pnlPercent) - Math.abs(a.holding.pnlPercent))[0];
  if (positionCandidate && Math.abs(positionCandidate.holding.pnlPercent) >= 5) return positionCandidate;
  return candidates[0] || {
    symbol: "NVDA",
    direction: "WAIT",
    actionLabel: "等待",
    score: 50,
    entryWindow: null,
    stop: null,
    targetWindow: null,
    sourceCount: 0,
    holding: null,
    moduleName: "AI核心趋势仓",
    allocationText: "等待报价",
    horizon: "按价格确认",
    windowState: "等待更多信号",
    reason: "等待更多新闻、价格和持仓信号确认。"
  };
}

function conclusionText(primary, riskBudget, dataQuality, serenitySignal) {
  const quality = `数据质量 ${dataQuality.label} ${dataQuality.score}/100`;
  const risk = riskBudget ? `单笔最大亏损控制在 ${money.format(riskBudget)}` : "先控制单笔风险";
  const serenity = serenitySignal ? "Serenity 有优先信号，已置顶纳入评分。" : "";
  if (primary.direction === "STOP") {
    return `组合主结论：${primary.symbol} 已触发风控窗口，优先执行止损或减仓；${risk}。${quality}。`;
  }
  if (primary.direction === "TRIM") {
    return `组合主结论：${primary.symbol} 接近卖出窗口，适合分批止盈并上移保护线；${risk}。${quality}。`;
  }
  if (["BUY", "ADD"].includes(primary.direction)) {
    return `组合主结论：按长期策略优先处理 ${primary.symbol}，动作是${primary.actionLabel}，买点 ${formatWindow(primary.entryWindow)}，卖点 ${formatWindow(primary.targetWindow)}，止损 ${formatPrice(primary.stop)}；${risk}。${serenity} ${quality}。`;
  }
  return `组合主结论：不再每天押一只票，当前以组合仓位偏离、买卖窗口和来源优先级管理；${primary.symbol} 暂列首页观察，${risk}。${serenity} ${quality}。`;
}

function positionInsightText(holdings, modules, dataQuality) {
  if (!holdings.length) return `暂无持仓，今日主要按长期策略目标仓位、实时报价与来源优先级生成候选。${dataQuality.label}。`;
  const summary = summarizeHoldings(holdings);
  const leader = holdings[0];
  const drift = modules.filter((item) => item.status === "偏离较大").map((item) => item.name).join("、") || "无明显偏离";
  return `持仓总市值 ${money.format(summary.marketValue)}，浮盈亏 ${signedMoney.format(summary.unrealizedPnl)}；当前最需要关注 ${leader.symbol}：${leader.status}。仓位偏离：${drift}。`;
}

function buildReason(direction, momentum, sourceCount, hitRate, holding, rule, plan, prioritySource) {
  const action = actionText(direction);
  const momentumText = momentum > 0.2 ? "价格动能偏强" : momentum < -0.2 ? "价格动能偏弱" : "价格动能尚不明显";
  const holdingText = holding
    ? `；持仓浮盈亏 ${formatPercent(holding.pnlPercent)}`
    : "";
  const priorityText = prioritySource ? "；Serenity 信号优先加权" : "";
  return `${action}依据：${rule.thesis}；${momentumText}；${plan.windowState}；相关来源 ${sourceCount} 条；近期执行命中率约 ${Math.round(hitRate * 100)}%${holdingText}${priorityText}。`;
}

function buildModuleStatus(holdings, equity, cash) {
  const holdingsByModule = new Map();
  for (const holding of holdings) {
    const moduleId = RULE_BY_SYMBOL.get(holding.symbol)?.moduleId || "other";
    holdingsByModule.set(moduleId, round((holdingsByModule.get(moduleId) || 0) + holding.marketValue));
  }
  return STRATEGY_MODULES.map((module) => {
    const currentValue = module.id === "cash"
      ? Math.max(Number(cash || 0), 0)
      : Number(holdingsByModule.get(module.id) || 0);
    const currentPercent = equity ? currentValue / equity * 100 : 0;
    const gap = currentPercent - module.targetPercent;
    const status = Math.abs(gap) >= 8 ? "偏离较大" : Math.abs(gap) >= 4 ? "需微调" : "接近计划";
    return { ...module, currentValue, currentPercent, gap, status };
  });
}

function buildDataQuality(quotes, sources, dataMode) {
  const liveQuotes = quotes.filter((quote) => !/sample|示例/i.test(String(quote.source || ""))).length;
  const quoteScore = quotes.length ? liveQuotes / quotes.length * 42 : 0;
  const sourceScore = Math.min(sources.length * 3, 24);
  const priorityScore = sources.some(isSerenitySource) ? 14 : 0;
  const modeScore = dataMode === "live" ? 18 : dataMode === "snapshot" ? 10 : 2;
  const score = clamp(Math.round(quoteScore + sourceScore + priorityScore + modeScore), 20, 98);
  const label = dataMode === "live" ? "实时" : dataMode === "snapshot" ? "每日快照" : "示例兜底";
  return { score, label };
}

function allocationFor(rule, equity, holding) {
  const current = Number(holding?.marketValue || 0);
  if (rule.tradeAmount) {
    const scaled = rule.tradeAmount.map((value) => round(value / STRATEGY_BASE_EQUITY * equity));
    return {
      target: scaled[1],
      gap: scaled[1] - current,
      gapPercent: equity ? (scaled[1] - current) / equity * 100 : 0,
      text: `单笔 ${formatMoneyRange(scaled)}`
    };
  }
  const target = round(Number(rule.baseAmount || 0) / STRATEGY_BASE_EQUITY * equity);
  return {
    target,
    gap: target - current,
    gapPercent: equity ? (target - current) / equity * 100 : 0,
    text: `目标 ${money.format(target)}（${formatPercent(target / equity * 100)}）`
  };
}

function sourceHitsFor(symbol, sources) {
  return sources.filter((item) => {
    if (Array.isArray(item.symbols) && item.symbols.includes(symbol)) return true;
    return textMentionsSymbol(`${item.title || ""} ${item.summary || ""}`, symbol);
  });
}

function findSerenitySignal(sources) {
  return sources.find(isSerenitySource) || null;
}

function prioritizeSources(sources) {
  return sources.map(normalizeSource).sort((a, b) => {
    const priority = Number(b.priority || 0) - Number(a.priority || 0);
    if (priority) return priority;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });
}

function normalizeSource(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  const symbols = Array.isArray(item.symbols) && item.symbols.length ? item.symbols : extractSymbols(text);
  const basePriority = Number(item.priority || 0);
  const priority = basePriority + (basePriority < 100 && isSerenitySource(item) ? 100 : 0);
  return {
    ...item,
    symbols,
    priority,
    url: item.url || ""
  };
}

function isSerenitySource(item) {
  return Number(item.priority || 0) >= 100 || /serenity/i.test(`${item.provider || ""} ${item.author || ""} ${item.handle || ""} ${item.title || ""}`);
}

function extractSymbols(text) {
  return STRATEGY_SYMBOLS.filter((symbol) => textMentionsSymbol(text, symbol));
}

function textMentionsSymbol(text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z])\\$?${escaped}([^A-Z]|$)`, "i").test(String(text || ""));
}

function completeQuotes(symbols, quotes) {
  const sample = new Map(sampleQuotes(symbols).map((quote) => [quote.symbol, quote]));
  const quoteBySymbol = new Map((quotes || []).filter((quote) => quote.symbol).map((quote) => [String(quote.symbol).toUpperCase(), {
    ...quote,
    symbol: String(quote.symbol).toUpperCase(),
    price: Number(quote.price || 0),
    change: Number(quote.change || 0),
    changePercent: Number(quote.changePercent || 0)
  }]));
  return symbols.map((symbol) => quoteBySymbol.get(symbol) || sample.get(symbol) || {
    symbol,
    price: 0,
    change: 0,
    changePercent: 0,
    source: "Sample"
  });
}

function buildProviderStatus(liveData, snapshot, quotes, sources) {
  const quoteSource = quotes.some((quote) => !/sample/i.test(String(quote.source || "")))
    ? quotes.find((quote) => !/sample/i.test(String(quote.source || "")))?.source || "实时报价"
    : "示例报价";
  return {
    行情: liveData?.providers?.market || snapshot?.providers?.market || quoteSource,
    来源: liveData?.providers?.sources || snapshot?.providers?.sources || `${sources.length} 条`,
    Serenity: sources.some(isSerenitySource) ? "已置顶" : "未捕捉到新帖",
    存储: state.apiMode ? "Node 数据文件" : "浏览器本地保存"
  };
}

function sampleQuotes(symbols) {
  const base = {
    NVDA: [143.62, 1.28],
    MSFT: [487.12, 0.31],
    AMD: [166.48, 0.86],
    ARM: [134.8, -1.2],
    PLTR: [122.35, 2.1],
    TSLA: [182.14, -0.82],
    SOXL: [24.36, 2.9],
    TQQQ: [77.42, 1.6],
    TSLL: [9.18, -1.7],
    QQQ: [547.88, 0.72],
    SPY: [634.21, 0.44]
  };
  return symbols.map((symbol) => {
    const [price, changePercent] = base[symbol] || [100, 0];
    return { symbol, price, change: round(price * changePercent / 100), changePercent, source: "Sample fallback" };
  });
}

function sampleSources() {
  const now = new Date().toISOString();
  return [
    {
      type: "x",
      provider: "X · Serenity sample",
      author: "Serenity",
      title: "Serenity watch: NVDA remains the first AI trend name to track before adding beta.",
      summary: "Sample priority signal. Configure X_BEARER_TOKEN and SERENITY_X_ACCOUNT to replace this with Serenity's newest X posts.",
      url: "https://x.com/search?q=Serenity%20%24NVDA%20%24PLTR%20%24TSLA&src=typed_query&f=live",
      publishedAt: now,
      sentiment: 1,
      priority: 120,
      symbols: ["NVDA", "PLTR", "TSLA"]
    },
    {
      type: "news",
      provider: "Yahoo Finance",
      title: "NVDA and QQQ show stronger AI-led momentum",
      summary: "Large-cap technology names lead the watchlist while traders wait for fresh macro data.",
      url: "https://finance.yahoo.com/quote/NVDA",
      publishedAt: now,
      sentiment: 1,
      symbols: ["NVDA", "QQQ"]
    },
    {
      type: "news",
      provider: "Yahoo Finance",
      title: "TSLA remains volatile after mixed analyst commentary",
      summary: "Options flow points to a wider intraday range and higher risk of false breakouts.",
      url: "https://finance.yahoo.com/quote/TSLA",
      publishedAt: now,
      sentiment: -0.5,
      symbols: ["TSLA", "TSLL"]
    },
    {
      type: "youtube",
      provider: "YouTube",
      title: "Morning market setup: index levels, earnings risk, and AI leaders",
      summary: "Video search fallback for daily market context.",
      url: "https://www.youtube.com/results?search_query=stock+market+analysis+today+AI+NVDA",
      publishedAt: now,
      sentiment: 0.5,
      symbols: ["NVDA", "QQQ", "TQQQ"]
    }
  ];
}

function holdingStatus(pnlPercent, momentum, price, stop, targetWindow) {
  if (price && stop && price <= stop) return "触及止损，优先退出";
  if (price && targetWindow && price >= targetWindow[0]) return "进入卖出窗口，分批止盈";
  if (pnlPercent >= 8 && momentum >= 0) return "趋势盈利，上移保护线";
  if (pnlPercent >= 8 && momentum < 0) return "高位回撤，守保护线";
  if (pnlPercent <= -6 && momentum < 0) return "亏损扩大，避免摊平";
  if (pnlPercent <= -6 && momentum >= 0) return "亏损修复，等确认再加仓";
  if (momentum > 1) return "价格转强，可小仓观察";
  if (momentum < -1) return "价格转弱，降低追高";
  return "区间震荡，按计划持有";
}

function holdingSignalScore(holding, plan, momentum) {
  if (holding.currentPrice && plan.stop && holding.currentPrice <= plan.stop) return -18;
  if (holding.currentPrice && plan.targetWindow && holding.currentPrice >= plan.targetWindow[0]) return 6;
  if (holding.pnlPercent <= -6 && momentum < 0) return -11;
  if (holding.pnlPercent >= 8 && momentum < 0) return -5;
  if (holding.pnlPercent >= 4 && momentum > 0) return 5;
  if (holding.pnlPercent <= -4 && momentum > 1) return 2;
  return holding.pnlPercent > 0 ? 2 : -1;
}

function summarizeHoldings(holdings) {
  return holdings.reduce((summary, holding) => ({
    marketValue: round(summary.marketValue + holding.marketValue),
    costBasis: round(summary.costBasis + holding.costBasis),
    unrealizedPnl: round(summary.unrealizedPnl + holding.unrealizedPnl)
  }), { marketValue: 0, costBasis: 0, unrealizedPnl: 0 });
}

function defaultRule(symbol) {
  return {
    symbol,
    moduleId: "watch",
    baseAmount: 0,
    targetReturn: [6, 12],
    stopPercent: 8,
    horizon: "观察",
    thesis: "非核心策略池标的，只作为持仓风控观察"
  };
}

function actionText(direction) {
  return {
    BUY: "买入",
    ADD: "加仓观察",
    TRIM: "分批止盈",
    STOP: "止损退出",
    SELL: "卖出/做空",
    HOLD: "持有",
    WAIT: "等待"
  }[direction] || "等待";
}

function openDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog) return;
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog?.open) dialog.close();
}

function pickNumbers(input, keys) {
  return keys.reduce((result, key) => {
    if (input[key] !== undefined && input[key] !== "") result[key] = Number(input[key]);
    return result;
  }, {});
}

function rangeUsable(range, price, threshold) {
  if (!range || !price) return false;
  const [low, high] = normalizeRange(range);
  const mid = (low + high) / 2;
  return Math.abs(price - mid) / Math.max(price, mid) <= threshold;
}

function isInRange(value, range) {
  if (!value || !range) return false;
  const [low, high] = normalizeRange(range);
  return value >= low && value <= high;
}

function normalizeRange(range) {
  if (!Array.isArray(range)) return null;
  return [round(Math.min(...range)), round(Math.max(...range))];
}

function uniqueSymbols(items) {
  return [...new Set(items.map((item) => String(item || "").toUpperCase().trim()).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatPrice(value) {
  return Number(value) ? money.format(Number(value)) : "--";
}

function formatWindow(value) {
  if (!value) return "--";
  if (Array.isArray(value)) {
    const [low, high] = normalizeRange(value);
    if (Math.abs(low - high) < 0.01) return formatPrice(low);
    return `${formatPrice(low)}-${formatPrice(high)}`;
  }
  return formatPrice(value);
}

function formatMoneyRange(range) {
  if (!range) return "--";
  const [low, high] = normalizeRange(range);
  return `${money.format(low)}-${money.format(high)}`;
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatShares(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatDate(value) {
  if (!value) return "--";
  const raw = String(value);
  const normalized = /^\d{8}T\d{6}/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`
    : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function safeUrl(value) {
  if (!value || value === "#") return "";
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

let toastTimer;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("show"), 2600);
}
