const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const { randomUUID } = require("crypto");

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const statePath = path.join(dataDir, "state.json");

loadEnv(path.join(root, ".env"));

const PORT = Number(process.env.PORT || 5177);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const STRATEGY_SYMBOLS = ["NVDA", "MSFT", "AMD", "ARM", "PLTR", "TSLA", "SOXL", "TQQQ", "TSLL"];
const WATCHLIST = uniqueSymbols(splitEnv("WATCHLIST", [...STRATEGY_SYMBOLS, "QQQ", "SPY"]));
const SERENITY_X_ACCOUNT = String(process.env.SERENITY_X_ACCOUNT || "Serenity").replace(/^@/, "");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/api/dashboard" && req.method === "GET") {
      return sendJson(res, await buildDashboard());
    }

    if (url.pathname === "/api/trades" && req.method === "POST") {
      const input = await readJson(req);
      const state = await readState();
      const trade = normalizeTrade(input);
      state.trades.unshift(trade);
      state.account = updateAccountFromTrade(state.account, trade);
      await writeState(state);
      return sendJson(res, { ok: true, trade, account: state.account });
    }

    if (parts[0] === "api" && parts[1] === "trades" && parts[2] && req.method === "DELETE") {
      const state = await readState();
      const id = decodeURIComponent(parts[2]);
      const removed = state.trades.find((trade) => trade.id === id);
      state.trades = state.trades.filter((trade) => trade.id !== id);
      if (removed) state.account = rollbackAccountFromTrade(state.account, removed);
      await writeState(state);
      return sendJson(res, { ok: true });
    }

    if (url.pathname === "/api/holdings" && ["POST", "PUT"].includes(req.method)) {
      const input = await readJson(req);
      const state = await readState();
      const holding = normalizeHolding(input);
      const nextHoldings = state.holdings.filter((item) => item.symbol !== holding.symbol);
      state.holdings = [holding, ...nextHoldings].sort((a, b) => a.symbol.localeCompare(b.symbol));
      await writeState(state);
      return sendJson(res, { ok: true, holding });
    }

    if (parts[0] === "api" && parts[1] === "holdings" && parts[2] && req.method === "DELETE") {
      const state = await readState();
      const symbol = decodeURIComponent(parts[2]).toUpperCase();
      state.holdings = state.holdings.filter((holding) => holding.symbol !== symbol);
      await writeState(state);
      return sendJson(res, { ok: true });
    }

    if (url.pathname === "/api/account" && req.method === "PUT") {
      const input = await readJson(req);
      const state = await readState();
      state.account = {
        ...state.account,
        ...pick(input, ["cash", "equity", "dayPnl", "totalPnl", "riskPerTrade"]),
        updatedAt: new Date().toISOString()
      };
      await writeState(state);
      return sendJson(res, { ok: true, account: state.account });
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      return sendJson(res, {
        providers: providerFlags(),
        watchlist: WATCHLIST,
        serenityXAccount: SERENITY_X_ACCOUNT,
        xAccounts: splitEnv("X_ACCOUNTS", []),
        youtubeQueries: splitEnv("YOUTUBE_QUERIES", [])
      });
    }

    if (req.method === "GET") return serveStatic(url.pathname, res);
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message || "Server error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Memymoney dashboard: http://localhost:${PORT}`);
});

async function buildDashboard() {
  const state = await readState();
  const symbols = uniqueSymbols([...WATCHLIST, ...state.holdings.map((holding) => holding.symbol)]);
  const [quoteResult, newsResult, xResult, youtubeResult] = await Promise.all([
    safeProvider(() => fetchQuotes(symbols), sampleQuotes(symbols), "行情备用样本"),
    safeProvider(() => fetchNews(symbols), sampleNews(), "新闻备用样本"),
    safeProvider(() => fetchXSignals(), sampleSocial(), "X备用样本"),
    safeProvider(() => fetchYoutubeSignals(), sampleVideos(), "YouTube备用样本")
  ]);
  const sources = prioritizeSources([...newsResult.value, ...xResult.value, ...youtubeResult.value]);
  return {
    asOf: new Date().toISOString(),
    account: state.account,
    holdings: state.holdings,
    trades: state.trades.slice(0, 50),
    quotes: quoteResult.value,
    sources,
    providers: {
      market: quoteResult.status,
      sources: `${newsResult.status} / ${xResult.status} / ${youtubeResult.status}`,
      ...providerFlags()
    }
  };
}

async function safeProvider(task, fallback, fallbackStatus) {
  try {
    const value = await task();
    if (!Array.isArray(value) || !value.length) return { value: fallback, status: fallbackStatus };
    const firstLive = value.find((item) => item.source || item.provider);
    return { value, status: firstLive?.source || firstLive?.provider || "已更新" };
  } catch (error) {
    return { value: fallback, status: `${fallbackStatus}: ${error.message || "请求失败"}` };
  }
}

async function fetchQuotes(symbols) {
  if (process.env.TWELVE_DATA_API_KEY) {
    const twelveData = await fetchTwelveDataQuotes(symbols);
    if (twelveData.length) return mergeQuotes(symbols, twelveData, sampleQuotes(symbols));
    return sampleQuotes(symbols);
  }
  const yahoo = await fetchYahooQuotes(symbols);
  if (yahoo.length) return mergeQuotes(symbols, yahoo, sampleQuotes(symbols));
  return sampleQuotes(symbols);
}

async function fetchTwelveDataQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(async (symbol) => {
    const url = new URL("https://api.twelvedata.com/quote");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", process.env.TWELVE_DATA_API_KEY);
    const data = await fetchJson(url, {}, 6500);
    return {
      symbol,
      price: Number(data.close || data.price || 0),
      change: Number(data.change || 0),
      changePercent: Number(String(data.percent_change || "0").replace("%", "")),
      source: "Twelve Data"
    };
  }));
  return results
    .filter((item) => item.status === "fulfilled" && item.value.price)
    .map((item) => item.value);
}

async function fetchYahooQuotes(symbols) {
  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("fields", "regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketTime,shortName");
  const data = await fetchJson(url, {
    headers: { "user-agent": "Mozilla/5.0" }
  }, 6500);
  return (data.quoteResponse?.result || []).map((item) => ({
    symbol: String(item.symbol || "").toUpperCase(),
    price: Number(item.regularMarketPrice || 0),
    change: Number(item.regularMarketChange || 0),
    changePercent: Number(item.regularMarketChangePercent || 0),
    source: "Yahoo Finance",
    asOf: item.regularMarketTime ? new Date(item.regularMarketTime * 1000).toISOString() : new Date().toISOString()
  })).filter((item) => item.symbol && item.price);
}

function mergeQuotes(symbols, primary, fallback) {
  const bySymbol = new Map(fallback.map((quote) => [quote.symbol, quote]));
  for (const quote of primary) bySymbol.set(quote.symbol, quote);
  return symbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
}

async function fetchNews(symbols) {
  if (!process.env.ALPHA_VANTAGE_API_KEY) return sampleNews();
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "NEWS_SENTIMENT");
  url.searchParams.set("tickers", symbols.join(","));
  url.searchParams.set("limit", "30");
  url.searchParams.set("apikey", process.env.ALPHA_VANTAGE_API_KEY);
  const data = await fetchJson(url, {}, 6500);
  return (data.feed || []).slice(0, 16).map((item) => ({
    type: "news",
    provider: item.source ? `Alpha Vantage · ${item.source}` : "Alpha Vantage",
    title: item.title,
    summary: item.summary || "",
    url: item.url,
    publishedAt: item.time_published,
    sentiment: sentimentToNumber(item.overall_sentiment_label, item.overall_sentiment_score),
    symbols: extractSymbols(`${item.title} ${item.summary}`)
  }));
}

async function fetchXSignals() {
  const accounts = uniqueSymbols([SERENITY_X_ACCOUNT, ...splitEnv("X_ACCOUNTS", [])]).map((item) => item.replace(/^@/, ""));
  if (!process.env.X_BEARER_TOKEN || !accounts.length) return sampleSocial();
  const accountQuery = accounts.map((account) => `from:${account}`).join(" OR ");
  const symbolQuery = STRATEGY_SYMBOLS.map((symbol) => `$${symbol}`).join(" OR ");
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", `(${accountQuery}) (${symbolQuery} OR AI OR stock OR stocks OR market OR earnings) -is:retweet`);
  url.searchParams.set("max_results", "20");
  url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name");
  const data = await fetchJson(url, {
    headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
  }, 6500);
  const users = new Map((data.includes?.users || []).map((user) => [user.id, user]));
  return (data.data || []).map((tweet) => {
    const user = users.get(tweet.author_id) || {};
    const username = user.username || SERENITY_X_ACCOUNT;
    const isSerenity = username.toLowerCase() === SERENITY_X_ACCOUNT.toLowerCase()
      || String(user.name || "").toLowerCase().includes("serenity");
    return {
      type: "x",
      provider: isSerenity ? "X · Serenity" : `X · @${username}`,
      author: user.name || username,
      handle: username,
      title: tweet.text.slice(0, 140),
      summary: tweet.text,
      url: `https://x.com/${username}/status/${tweet.id}`,
      publishedAt: tweet.created_at,
      sentiment: keywordSentiment(tweet.text),
      priority: isSerenity ? 120 : 20,
      symbols: extractSymbols(tweet.text)
    };
  });
}

async function fetchYoutubeSignals() {
  const queries = splitEnv("YOUTUBE_QUERIES", []);
  if (!process.env.YOUTUBE_API_KEY || !queries.length) return sampleVideos();
  const results = await Promise.allSettled(queries.map(async (query) => {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("order", "date");
    url.searchParams.set("q", query);
    url.searchParams.set("key", process.env.YOUTUBE_API_KEY);
    const data = await fetchJson(url, {}, 6500);
    return (data.items || []).map((item) => ({
      type: "youtube",
      provider: `YouTube · ${item.snippet.channelTitle || "channel"}`,
      title: item.snippet.title,
      summary: item.snippet.description || item.snippet.channelTitle,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      publishedAt: item.snippet.publishedAt,
      sentiment: keywordSentiment(`${item.snippet.title} ${item.snippet.description}`),
      symbols: extractSymbols(`${item.snippet.title} ${item.snippet.description}`)
    }));
  }));
  return results.flatMap((item) => (item.status === "fulfilled" ? item.value : []));
}

async function fetchJson(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`API request failed: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) return sendJson(res, { error: "Forbidden" }, 403);
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(body);
  } catch {
    sendJson(res, { error: "Not found" }, 404);
  }
}

async function readState() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return {
      account: normalizeAccount(parsed.account || {}),
      holdings: Array.isArray(parsed.holdings) ? parsed.holdings.map(normalizeHolding).filter((item) => item.shares > 0) : [],
      trades: Array.isArray(parsed.trades) ? parsed.trades.map(normalizeTrade) : [],
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : WATCHLIST
    };
  } catch {
    const state = {
      account: normalizeAccount({}),
      holdings: [],
      trades: [],
      watchlist: WATCHLIST
    };
    await writeState(state);
    return state;
  }
}

function writeState(state) {
  return fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
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
    id: input.id || randomUUID(),
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[path.extname(filePath)] || "application/octet-stream";
}

function loadEnv(filePath) {
  try {
    const text = require("fs").readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional; sample data keeps the app usable.
  }
}

function splitEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function pick(input, keys) {
  return keys.reduce((result, key) => {
    if (input[key] !== undefined && input[key] !== "") result[key] = Number(input[key]);
    return result;
  }, {});
}

function providerFlags() {
  return {
    alphaVantage: Boolean(process.env.ALPHA_VANTAGE_API_KEY),
    twelveData: Boolean(process.env.TWELVE_DATA_API_KEY),
    yahoo: true,
    x: Boolean(process.env.X_BEARER_TOKEN),
    youtube: Boolean(process.env.YOUTUBE_API_KEY)
  };
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
  const priority = basePriority + (basePriority < 100 && /serenity/i.test(`${item.provider || ""} ${item.author || ""} ${item.handle || ""}`) ? 100 : 0);
  return { ...item, symbols, priority };
}

function extractSymbols(text) {
  return STRATEGY_SYMBOLS.filter((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z])\\$?${escaped}([^A-Z]|$)`, "i").test(String(text || ""));
  });
}

function sentimentToNumber(label, score) {
  if (score !== undefined) return clamp(Number(score) * 2, -2, 2);
  const normalized = String(label || "").toLowerCase();
  if (normalized.includes("bull") || normalized.includes("positive")) return 1;
  if (normalized.includes("bear") || normalized.includes("negative")) return -1;
  return 0;
}

function keywordSentiment(text) {
  const normalized = String(text || "").toLowerCase();
  const bullish = ["beat", "surge", "rally", "upgrade", "breakout", "bull", "strong", "accumulate", "buy"];
  const bearish = ["miss", "drop", "selloff", "downgrade", "risk", "bear", "weak", "avoid", "cut"];
  return bullish.reduce((sum, word) => sum + Number(normalized.includes(word)), 0)
    - bearish.reduce((sum, word) => sum + Number(normalized.includes(word)), 0);
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

function sampleNews() {
  const now = new Date().toISOString();
  return [
    {
      type: "news",
      provider: "Yahoo Finance sample",
      title: "NVDA and QQQ show stronger AI-led momentum",
      summary: "Large-cap technology names lead the watchlist while traders wait for fresh macro data.",
      url: "https://finance.yahoo.com/quote/NVDA",
      publishedAt: now,
      sentiment: 1,
      symbols: ["NVDA", "QQQ"]
    },
    {
      type: "news",
      provider: "Yahoo Finance sample",
      title: "TSLA remains volatile after mixed analyst commentary",
      summary: "Options flow points to a wider intraday range and higher risk of false breakouts.",
      url: "https://finance.yahoo.com/quote/TSLA",
      publishedAt: now,
      sentiment: -0.5,
      symbols: ["TSLA", "TSLL"]
    }
  ];
}

function sampleSocial() {
  return [{
    type: "x",
    provider: "X · Serenity sample",
    author: "Serenity",
    handle: SERENITY_X_ACCOUNT,
    title: "Serenity watch: NVDA remains the first AI trend name before adding beta.",
    summary: "Sample priority signal. Configure X_BEARER_TOKEN and SERENITY_X_ACCOUNT to use Serenity's newest X posts.",
    url: "https://x.com/search?q=Serenity%20%24NVDA%20%24PLTR%20%24TSLA&src=typed_query&f=live",
    publishedAt: new Date().toISOString(),
    sentiment: 1,
    priority: 120,
    symbols: ["NVDA", "PLTR", "TSLA"]
  }];
}

function sampleVideos() {
  return [{
    type: "youtube",
    provider: "YouTube sample",
    title: "Morning market setup: index levels, earnings risk, and AI leaders",
    summary: "Video search fallback for daily market context.",
    url: "https://www.youtube.com/results?search_query=stock+market+analysis+today+AI+NVDA",
    publishedAt: new Date().toISOString(),
    sentiment: 0.5,
    symbols: ["NVDA", "QQQ", "TQQQ"]
  }];
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
