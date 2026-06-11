import fs from "node:fs/promises";
import path from "node:path";

const STRATEGY_SYMBOLS = ["NVDA", "MSFT", "AMD", "ARM", "PLTR", "TSLA", "SOXL", "TQQQ", "TSLL"];
const WATCHLIST = uniqueSymbols((process.env.WATCHLIST || `${STRATEGY_SYMBOLS.join(",")},QQQ,SPY`).split(","));
const SERENITY_X_ACCOUNT = String(process.env.SERENITY_X_ACCOUNT || "Serenity").replace(/^@/, "");

const providers = {};
const [quotes, news, xSignals, videos] = await Promise.all([
  safe("market", () => fetchQuotes(WATCHLIST), sampleQuotes(WATCHLIST)),
  safe("news", () => fetchNews(WATCHLIST), sampleNews()),
  safe("x", fetchXSignals, sampleSocial()),
  safe("youtube", fetchYoutubeSignals, sampleVideos())
]);

const snapshot = {
  asOf: new Date().toISOString(),
  quotes,
  sources: prioritizeSources([...news, ...xSignals, ...videos]),
  providers: {
    market: providers.market || "行情备用样本",
    sources: [providers.news, providers.x, providers.youtube].filter(Boolean).join(" / ") || "来源备用样本"
  }
};

await writeJson(path.join("data", "market-snapshot.json"), snapshot);
await writeJson(path.join("public", "data", "market-snapshot.json"), snapshot);
console.log(`snapshot generated: ${snapshot.quotes.length} quotes, ${snapshot.sources.length} sources`);

async function safe(name, task, fallback) {
  try {
    const value = await task();
    if (!Array.isArray(value) || !value.length) throw new Error("empty result");
    providers[name] = providerName(value[0]) || "updated";
    return value;
  } catch (error) {
    providers[name] = `fallback: ${error.message || "request failed"}`;
    return fallback;
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
  return results.filter((item) => item.status === "fulfilled" && item.value.price).map((item) => item.value);
}

async function fetchYahooQuotes(symbols) {
  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbols.join(","));
  const data = await fetchJson(url, { headers: { "user-agent": "Mozilla/5.0" } }, 6500);
  return (data.quoteResponse?.result || []).map((item) => ({
    symbol: String(item.symbol || "").toUpperCase(),
    price: Number(item.regularMarketPrice || 0),
    change: Number(item.regularMarketChange || 0),
    changePercent: Number(item.regularMarketChangePercent || 0),
    source: "Yahoo Finance",
    asOf: item.regularMarketTime ? new Date(item.regularMarketTime * 1000).toISOString() : new Date().toISOString()
  })).filter((item) => item.symbol && item.price);
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
  const accounts = uniqueSymbols([SERENITY_X_ACCOUNT, ...(process.env.X_ACCOUNTS || "").split(",")]).map((item) => item.replace(/^@/, ""));
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
  const queries = (process.env.YOUTUBE_QUERIES || "").split(",").map((item) => item.trim()).filter(Boolean);
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function mergeQuotes(symbols, primary, fallback) {
  const bySymbol = new Map(fallback.map((quote) => [quote.symbol, quote]));
  for (const quote of primary) bySymbol.set(quote.symbol, quote);
  return symbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
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

function providerName(item) {
  return item.source || item.provider || "";
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
