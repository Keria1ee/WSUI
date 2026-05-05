import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

await loadDotEnv();

const app = express();
const port = Number(process.env.PORT || 8787);
const quoteCacheSeconds = Number(process.env.QUOTE_CACHE_SECONDS || 60);
const groupPassword = process.env.GROUP_PASSWORD || '';
const finnhubApiKey = process.env.FINNHUB_API_KEY || '';

const quoteCache = new Map();
const historyCache = new Map();

const demoQuotes = {
  NVDA: { price: 202.5, previousClose: 199.88, open: 200.15, high: 204.2, low: 198.71 },
  SNDK: { price: 1187, previousClose: 1096.1, open: 1134.5, high: 1189.24, low: 1110.3 },
  MU: { price: 487.48, previousClose: 449.37, open: 458.4, high: 491.2, low: 452.8 },
  ORCL: { price: 226.35, previousClose: 222.91, open: 224.18, high: 227.4, low: 221.6 },
  INTC: { price: 65.27, previousClose: 66.26, open: 66.04, high: 66.78, low: 64.91 },
  QQQ: { price: 659.8, previousClose: 652.5, open: 655.2, high: 661.1, low: 651.7 }
};

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    passwordRequired: Boolean(groupPassword),
    quoteProvider: finnhubApiKey ? 'finnhub' : 'demo'
  });
});

app.use('/api', requireGroupPassword);

app.get('/api/fund', async (_req, res, next) => {
  try {
    res.json(await readFund());
  } catch (error) {
    next(error);
  }
});

app.get('/api/snapshot', async (_req, res, next) => {
  try {
    const fund = await readFund();
    const quotesBySymbol = await getQuotesForFund(fund);
    res.json(calculateSnapshot(fund, quotesBySymbol));
  } catch (error) {
    next(error);
  }
});

app.get('/api/history', async (_req, res, next) => {
  try {
    const fund = await readFund();
    const quotesBySymbol = await getQuotesForFund(fund);
    const snapshot = calculateSnapshot(fund, quotesBySymbol);
    const history = await buildHistory(fund, snapshot);
    res.json(history);
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }

  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) {
      next();
    }
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'SERVER_ERROR', message: error.message });
});

app.listen(port, () => {
  console.log(`WSUI API listening on http://127.0.0.1:${port}`);
});

async function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  const text = await readFile(envPath, 'utf8').catch(() => '');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requireGroupPassword(req, res, next) {
  if (!groupPassword) {
    return next();
  }

  const provided = req.get('x-wsui-password') || req.query.access || '';
  if (provided === groupPassword) {
    return next();
  }

  return res.status(401).json({ error: 'PASSWORD_REQUIRED' });
}

async function readFund() {
  const fund = JSON.parse(await readFile(path.join(dataDir, 'fund.json'), 'utf8'));
  const totalWeight = fund.holdings.reduce((sum, holding) => sum + Number(holding.targetWeight || 0), 0);

  return {
    ...fund,
    holdings: fund.holdings.map((holding) => ({
      ...holding,
      targetWeight: totalWeight > 0 ? Number(holding.targetWeight || 0) / totalWeight : 0
    }))
  };
}

async function getQuotesForFund(fund) {
  const symbols = [...new Set([...fund.holdings.map((holding) => holding.symbol), fund.benchmark.symbol])];
  const quoteEntries = await Promise.all(symbols.map(async (symbol) => [symbol, await getQuote(symbol)]));
  return Object.fromEntries(quoteEntries);
}

async function getQuote(symbol) {
  const normalizedSymbol = symbol.toUpperCase();
  const cached = quoteCache.get(normalizedSymbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const quote = await fetchQuote(normalizedSymbol);
  quoteCache.set(normalizedSymbol, {
    data: quote,
    expiresAt: Date.now() + quoteCacheSeconds * 1000
  });

  return quote;
}

async function fetchQuote(symbol) {
  if (!finnhubApiKey) {
    return makeDemoQuote(symbol);
  }

  const url = new URL('https://finnhub.io/api/v1/quote');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', finnhubApiKey);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Finnhub quote request failed with ${response.status}`);
    }

    const data = await response.json();
    if (!isPositiveNumber(data.c)) {
      throw new Error(`Finnhub returned no current price for ${symbol}`);
    }

    const previousClose = isPositiveNumber(data.pc) ? Number(data.pc) : Number(data.c);
    const price = Number(data.c);

    return {
      symbol,
      price,
      previousClose,
      open: isPositiveNumber(data.o) ? Number(data.o) : null,
      high: isPositiveNumber(data.h) ? Number(data.h) : null,
      low: isPositiveNumber(data.l) ? Number(data.l) : null,
      change: Number.isFinite(data.d) ? Number(data.d) : price - previousClose,
      changePercent: Number.isFinite(data.dp) ? Number(data.dp) : percentage(price - previousClose, previousClose),
      timestamp: data.t ? new Date(Number(data.t) * 1000).toISOString() : new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      provider: 'finnhub',
      isDemo: false
    };
  } catch (error) {
    console.warn(`Falling back to demo quote for ${symbol}: ${error.message}`);
    return {
      ...makeDemoQuote(symbol),
      provider: 'demo-fallback',
      fallbackReason: error.message
    };
  }
}

function makeDemoQuote(symbol) {
  const fallback = demoQuotes[symbol] || { price: 100, previousClose: 99.5, open: 99.8, high: 101.1, low: 98.9 };
  const price = Number(fallback.price);
  const previousClose = Number(fallback.previousClose);

  return {
    symbol,
    price,
    previousClose,
    open: Number(fallback.open),
    high: Number(fallback.high),
    low: Number(fallback.low),
    change: price - previousClose,
    changePercent: percentage(price - previousClose, previousClose),
    timestamp: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    provider: 'demo',
    isDemo: true
  };
}

function calculateSnapshot(fund, quotesBySymbol) {
  const initialNav = Number(fund.initialNav || 100);
  const marketPriceConfig = getMarketPriceConfig(fund, initialNav);
  const configuredBaselines = fund.holdings.every((holding) => isPositiveNumber(holding.inceptionPrice));
  const benchmarkQuote = quotesBySymbol[fund.benchmark.symbol];
  const benchmarkBase = basePrice(fund.benchmark, benchmarkQuote);
  const benchmarkNav = initialNav * (benchmarkQuote.price / benchmarkBase);
  const holdings = fund.holdings.map((holding) => {
    const quote = quotesBySymbol[holding.symbol];
    const base = basePrice(holding, quote);
    const targetValue = initialNav * holding.targetWeight;
    const units = targetValue / base;
    const marketValue = units * quote.price;
    const previousValue = units * quote.previousClose;

    return {
      symbol: holding.symbol,
      name: holding.name,
      theme: holding.theme,
      targetWeight: holding.targetWeight,
      inceptionPrice: isPositiveNumber(holding.inceptionPrice) ? Number(holding.inceptionPrice) : null,
      baselinePrice: base,
      baselineSource: isPositiveNumber(holding.inceptionPrice) ? 'configured' : 'previousClose',
      units,
      price: quote.price,
      previousClose: quote.previousClose,
      change: quote.change,
      changePercent: quote.changePercent,
      marketValue,
      previousValue,
      provider: quote.provider,
      isDemo: quote.isDemo
    };
  });

  const nav = holdings.reduce((sum, holding) => sum + holding.marketValue, 0);
  const previousNav = holdings.reduce((sum, holding) => sum + holding.previousValue, 0);
  const marketPrice = marketPriceForNav(nav, initialNav, marketPriceConfig);
  const previousMarketPrice = marketPriceForNav(previousNav, initialNav, marketPriceConfig);
  const currentHoldings = holdings
    .map((holding) => ({
      ...holding,
      currentWeight: nav > 0 ? holding.marketValue / nav : 0,
      dayContributionPercent: previousNav > 0 ? ((holding.marketValue - holding.previousValue) / previousNav) * 100 : 0
    }))
    .sort((a, b) => b.marketValue - a.marketValue);

  const quoteList = Object.values(quotesBySymbol);
  const mode = quoteList.every((quote) => quote.isDemo)
    ? 'demo'
    : quoteList.some((quote) => quote.isDemo)
      ? 'mixed'
      : 'market';

  return {
    fund: {
      ticker: fund.ticker,
      name: fund.name,
      type: fund.type,
      theme: fund.theme,
      inceptionDate: fund.inceptionDate,
      initialNav,
      methodology: fund.methodology,
      disclaimer: fund.disclaimer
    },
    nav,
    previousNav,
    dayChange: nav - previousNav,
    dayChangePercent: percentage(nav - previousNav, previousNav),
    totalReturnPercent: percentage(nav - initialNav, initialNav),
    marketPrice,
    previousMarketPrice,
    performance: {
      asOf: new Date().toISOString().slice(0, 10),
      marketPrice: {
        label: 'Market Price',
        initial: marketPriceConfig.initialPrice,
        current: marketPrice,
        previous: previousMarketPrice,
        change: marketPrice - previousMarketPrice,
        changePercent: percentage(marketPrice - previousMarketPrice, previousMarketPrice),
        totalReturnPercent: percentage(marketPrice - marketPriceConfig.initialPrice, marketPriceConfig.initialPrice),
        medianBidAskSpreadPercent: marketPriceConfig.medianBidAskSpreadPercent
      },
      nav: {
        label: 'NAV',
        initial: initialNav,
        current: nav,
        previous: previousNav,
        change: nav - previousNav,
        changePercent: percentage(nav - previousNav, previousNav),
        totalReturnPercent: percentage(nav - initialNav, initialNav)
      }
    },
    holdings: currentHoldings,
    benchmark: {
      symbol: fund.benchmark.symbol,
      name: fund.benchmark.name,
      nav: benchmarkNav,
      dayChangePercent: percentage(benchmarkQuote.price - benchmarkQuote.previousClose, benchmarkQuote.previousClose),
      totalReturnPercent: percentage(benchmarkNav - initialNav, initialNav),
      price: benchmarkQuote.price,
      previousClose: benchmarkQuote.previousClose,
      baselinePrice: benchmarkBase
    },
    source: {
      mode,
      provider: finnhubApiKey ? 'finnhub' : 'demo',
      cacheSeconds: quoteCacheSeconds,
      baselineStatus: configuredBaselines ? 'configured' : 'derived-from-previous-close',
      passwordRequired: Boolean(groupPassword)
    },
    updatedAt: new Date().toISOString()
  };
}

async function buildHistory(fund, snapshot) {
  if (!finnhubApiKey) {
    return buildLaunchHistory(snapshot, 'demo');
  }

  const cacheKey = `${fund.ticker}:${fund.inceptionDate}:${new Date().toISOString().slice(0, 10)}`;
  const cached = historyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const history = await fetchFinnhubHistory(fund, snapshot);
    historyCache.set(cacheKey, {
      data: history,
      expiresAt: Date.now() + quoteCacheSeconds * 1000
    });
    return history;
  } catch (error) {
    console.warn(`History fallback: ${error.message}`);
    return buildLaunchHistory(snapshot, 'pending');
  }
}

async function fetchFinnhubHistory(fund, snapshot) {
  const fromDate = new Date(`${fund.inceptionDate}T00:00:00Z`);
  const toDate = new Date();

  if (toDate <= fromDate) {
    return buildLaunchHistory(snapshot, 'pending');
  }

  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(toDate.getTime() / 1000);
  const symbols = [...new Set([...fund.holdings.map((holding) => holding.symbol), fund.benchmark.symbol])];
  const candleEntries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchCandles(symbol, from, to)]));
  const candlesBySymbol = Object.fromEntries(candleEntries);
  const dates = commonDates(candlesBySymbol, symbols);

  if (dates.length < 2) {
    return buildLaunchHistory(snapshot, 'pending');
  }

  const holdingBases = Object.fromEntries(
    fund.holdings.map((holding) => {
      const firstClose = closeForDate(candlesBySymbol[holding.symbol], dates[0]);
      return [holding.symbol, isPositiveNumber(holding.inceptionPrice) ? Number(holding.inceptionPrice) : firstClose];
    })
  );
  const benchmarkFirstClose = closeForDate(candlesBySymbol[fund.benchmark.symbol], dates[0]);
  const benchmarkBase = isPositiveNumber(fund.benchmark.inceptionPrice)
    ? Number(fund.benchmark.inceptionPrice)
    : benchmarkFirstClose;

  const points = dates.map((date) => {
    const initialNav = Number(fund.initialNav || 100);
    const marketPriceConfig = getMarketPriceConfig(fund, initialNav);
    const wsui = fund.holdings.reduce((sum, holding) => {
      const close = closeForDate(candlesBySymbol[holding.symbol], date);
      return sum + initialNav * holding.targetWeight * (close / holdingBases[holding.symbol]);
    }, 0);
    const benchmarkClose = closeForDate(candlesBySymbol[fund.benchmark.symbol], date);

    return {
      date,
      wsui,
      nav: wsui,
      marketPrice: marketPriceForNav(wsui, initialNav, marketPriceConfig),
      benchmark: initialNav * (benchmarkClose / benchmarkBase)
    };
  });

  return { mode: 'market', points };
}

async function fetchCandles(symbol, from, to) {
  const url = new URL('https://finnhub.io/api/v1/stock/candle');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('resolution', 'D');
  url.searchParams.set('from', String(from));
  url.searchParams.set('to', String(to));
  url.searchParams.set('token', finnhubApiKey);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub candles failed for ${symbol} with ${response.status}`);
  }

  const data = await response.json();
  if (data.s !== 'ok' || !Array.isArray(data.t) || !Array.isArray(data.c)) {
    throw new Error(`No daily candles for ${symbol}`);
  }

  return Object.fromEntries(
    data.t.map((timestamp, index) => [
      new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
      Number(data.c[index])
    ])
  );
}

function buildLaunchHistory(snapshot, mode) {
  const points = [
    {
      date: snapshot.fund.inceptionDate,
      wsui: snapshot.fund.initialNav,
      nav: snapshot.fund.initialNav,
      marketPrice: snapshot.performance.marketPrice.initial,
      benchmark: snapshot.fund.initialNav
    },
    {
      date: new Date().toISOString().slice(0, 10),
      wsui: snapshot.nav,
      nav: snapshot.nav,
      marketPrice: snapshot.performance.marketPrice.current,
      benchmark: snapshot.benchmark.nav
    }
  ];

  return { mode, points };
}

function getMarketPriceConfig(fund, initialNav) {
  const config = fund.marketPrice || {};
  const premiumDiscountBps = Number(config.premiumDiscountBps || 0);

  return {
    initialPrice: isPositiveNumber(config.initialPrice) ? Number(config.initialPrice) : initialNav,
    premiumDiscountFactor: 1 + premiumDiscountBps / 10000,
    medianBidAskSpreadPercent: Number.isFinite(Number(config.medianBidAskSpreadPercent))
      ? Number(config.medianBidAskSpreadPercent)
      : 0
  };
}

function marketPriceForNav(nav, initialNav, marketPriceConfig) {
  if (!isPositiveNumber(initialNav)) {
    return Number(nav || 0);
  }

  return marketPriceConfig.initialPrice * (Number(nav) / initialNav) * marketPriceConfig.premiumDiscountFactor;
}

function commonDates(candlesBySymbol, symbols) {
  const [firstSymbol, ...restSymbols] = symbols;
  const firstDates = Object.keys(candlesBySymbol[firstSymbol] || {});

  return firstDates
    .filter((date) => restSymbols.every((symbol) => isPositiveNumber(candlesBySymbol[symbol]?.[date])))
    .sort();
}

function closeForDate(candles, date) {
  return Number(candles[date]);
}

function basePrice(holding, quote) {
  if (isPositiveNumber(holding.inceptionPrice)) {
    return Number(holding.inceptionPrice);
  }

  if (quote && isPositiveNumber(quote.previousClose)) {
    return Number(quote.previousClose);
  }

  if (quote && isPositiveNumber(quote.price)) {
    return Number(quote.price);
  }

  return 1;
}

function percentage(numerator, denominator) {
  if (!isPositiveNumber(denominator)) {
    return 0;
  }

  return (Number(numerator) / Number(denominator)) * 100;
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}
