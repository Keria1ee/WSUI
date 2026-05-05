import express from 'express';
import { readFile, writeFile } from 'node:fs/promises';
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

app.get('/api/alpha', async (_req, res, next) => {
  try {
    const fund = await readFund();
    const alpha = await readAlpha();
    res.json(await calculateAlphaEngine(fund, alpha));
  } catch (error) {
    next(error);
  }
});

app.post('/api/alpha/picks', async (req, res, next) => {
  try {
    const fund = await readFund();
    const alpha = await readAlpha();
    const member = normalizeMemberSubmission(req.body || {});
    member.picks = await hydratePickCosts(member.picks);
    const now = new Date().toISOString();
    const existingIndex = alpha.members.findIndex((entry) => entry.name.toLowerCase() === member.name.toLowerCase());

    if (existingIndex >= 0) {
      alpha.members[existingIndex] = {
        ...alpha.members[existingIndex],
        name: member.name,
        picks: member.picks,
        updatedAt: now
      };
    } else {
      alpha.members.push({
        name: member.name,
        picks: member.picks,
        influence: 1,
        previousInfluence: 1,
        joinedAt: now,
        updatedAt: now
      });
    }

    await writeAlpha(alpha);
    res.json(await calculateAlphaEngine(fund, alpha));
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.code, message: error.message });
    }

    next(error);
  }
});

app.post('/api/alpha/settle', async (_req, res, next) => {
  try {
    const fund = await readFund();
    const alpha = await readAlpha();
    const calculated = await calculateAlphaEngine(fund, alpha);

    if (!calculated.round.isDue) {
      return res.status(409).json({
        error: 'ROUND_NOT_DUE',
        message: `Next settlement opens on ${calculated.round.nextRebalanceAt}.`
      });
    }

    const projectedByName = Object.fromEntries(
      calculated.members.map((member) => [member.name.toLowerCase(), member.projectedInfluence])
    );

    alpha.members = alpha.members.map((member) => {
      const projectedInfluence = projectedByName[member.name.toLowerCase()] || Number(member.influence || 1);
      return {
        ...member,
        previousInfluence: Number(member.influence || 1),
        influence: projectedInfluence,
        settledAt: new Date().toISOString()
      };
    });
    alpha.settlements = [
      ...(alpha.settlements || []),
      {
        settledAt: new Date().toISOString(),
        weights: calculated.nextWeights,
        memberCount: calculated.members.length
      }
    ].slice(-12);
    alpha.settings.lastRebalanceAt = new Date().toISOString().slice(0, 10);

    await writeAlpha(alpha);
    res.json(await calculateAlphaEngine(fund, alpha));
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

async function readAlpha() {
  const fallback = {
    settings: {
      roundLengthDays: 7,
      lastRebalanceAt: new Date().toISOString().slice(0, 10),
      aggressiveness: 8,
      minInfluence: 0.3,
      maxInfluence: 3,
      smoothing: 0.35,
      maxTickerWeight: 0.35
    },
    members: [],
    settlements: []
  };
  const alpha = JSON.parse(await readFile(path.join(dataDir, 'picks.json'), 'utf8').catch(() => JSON.stringify(fallback)));

  return {
    ...fallback,
    ...alpha,
    settings: {
      ...fallback.settings,
      ...(alpha.settings || {})
    },
    members: Array.isArray(alpha.members) ? alpha.members : [],
    settlements: Array.isArray(alpha.settlements) ? alpha.settlements : []
  };
}

async function writeAlpha(alpha) {
  await writeFile(path.join(dataDir, 'picks.json'), `${JSON.stringify(alpha, null, 2)}\n`, 'utf8');
}

function normalizeMemberSubmission(body) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const picks = [
    {
      symbol: normalizeTicker(body.pickA || body.picks?.[0]?.symbol || body.picks?.[0]),
      costBasis: normalizeCostBasis(body.costA || body.picks?.[0]?.costBasis)
    },
    {
      symbol: normalizeTicker(body.pickB || body.picks?.[1]?.symbol || body.picks?.[1]),
      costBasis: normalizeCostBasis(body.costB || body.picks?.[1]?.costBasis)
    }
  ];

  if (name.length < 2 || name.length > 32) {
    throw validationError('INVALID_MEMBER', 'Member name must be 2-32 characters.');
  }

  if (!picks[0].symbol || !picks[1].symbol) {
    throw validationError('INVALID_PICK', 'Submit two ticker symbols.');
  }

  if (picks[0].symbol === picks[1].symbol) {
    throw validationError('DUPLICATE_PICK', 'Choose two different tickers.');
  }

  return { name, picks };
}

async function hydratePickCosts(picks) {
  return Promise.all(picks.map(async (pick) => {
    if (isPositiveNumber(pick.costBasis)) {
      return { ...pick, costBasis: Number(pick.costBasis), costSource: 'member' };
    }

    const quote = await getQuote(pick.symbol);
    return { ...pick, costBasis: quote.price, costSource: 'market-at-submit' };
  }));
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
    return '';
  }

  return ticker;
}

function normalizeCostBasis(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const costBasis = Number(value);
  return isPositiveNumber(costBasis) ? costBasis : null;
}

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

async function getQuotesForFund(fund) {
  const symbols = [...new Set([...fund.holdings.map((holding) => holding.symbol), fund.benchmark.symbol])];
  const quoteEntries = await Promise.all(symbols.map(async (symbol) => [symbol, await getQuote(symbol)]));
  return Object.fromEntries(quoteEntries);
}

async function calculateAlphaEngine(fund, alpha) {
  const settings = normalizeAlphaSettings(alpha.settings);
  const members = alpha.members
    .map(normalizeAlphaMember)
    .filter((member) => member.picks.length === 2);
  const symbols = [...new Set(members.flatMap((member) => member.picks.map((pick) => pick.symbol)))];
  const marketBySymbol = await getAlphaMarketData(symbols);

  const measuredMembers = members.map((member) => {
    const picks = member.picks.map((pick) => enrichPick(pick, marketBySymbol[pick.symbol]));
    const sevenDayReturn = average(picks.map((pick) => pick.sevenDayReturn));
    const costReturn = average(picks.map((pick) => pick.costReturn));
    const volatility = average(picks.map((pick) => pick.volatility));
    const compositeScore = average(picks.map((pick) => pick.compositeScore));

    return {
      ...member,
      picks,
      sevenDayReturn,
      costReturn,
      volatility,
      compositeScore
    };
  });

  const medianScore = median(measuredMembers.map((member) => member.compositeScore));
  const scoredMembers = measuredMembers
    .map((member) => {
      const currentInfluence = clamp(Number(member.influence || 1), settings.minInfluence, settings.maxInfluence);
      const excessScore = member.compositeScore - medianScore;
      const projectedInfluence = clamp(
        currentInfluence * Math.exp(settings.aggressiveness * excessScore),
        settings.minInfluence,
        settings.maxInfluence
      );

      return {
        ...member,
        currentInfluence,
        projectedInfluence,
        influenceChange: projectedInfluence - currentInfluence,
        excessScore
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  const rawTickerWeights = {};
  for (const member of scoredMembers) {
    for (const pick of member.picks) {
      rawTickerWeights[pick.symbol] = (rawTickerWeights[pick.symbol] || 0) + (member.projectedInfluence / 2) * pick.qualityMultiplier;
    }
  }

  const consensusWeights = normalizeWeightMap(rawTickerWeights, fund);
  const currentWeights = Object.fromEntries(fund.holdings.map((holding) => [holding.symbol, holding.targetWeight]));
  const smoothedWeights = smoothWeights(currentWeights, consensusWeights, settings.smoothing);
  const nextWeights = capWeights(smoothedWeights, settings.maxTickerWeight);
  const nextRebalanceAt = addDays(settings.lastRebalanceAt, settings.roundLengthDays);
  const nowDate = new Date().toISOString().slice(0, 10);
  const rankedWeights = Object.entries(nextWeights)
    .map(([symbol, weight]) => ({
      symbol,
      weight,
      consensusWeight: consensusWeights[symbol] || 0,
      currentWeight: currentWeights[symbol] || 0,
      ...describeSymbol(symbol, fund)
    }))
    .sort((a, b) => b.weight - a.weight);
  const topWeight = rankedWeights[0] || null;
  const topMember = scoredMembers[0] || null;

  return {
    settings,
    round: {
      lastRebalanceAt: settings.lastRebalanceAt,
      nextRebalanceAt,
      isDue: nowDate >= nextRebalanceAt,
      daysRemaining: Math.max(0, daysBetween(nowDate, nextRebalanceAt))
    },
    members: scoredMembers,
    market: Object.fromEntries(
      Object.entries(marketBySymbol).map(([symbol, market]) => [
        symbol,
        {
          symbol,
          price: market.price,
          sevenDayBase: market.sevenDayBase,
          sevenDayReturn: market.sevenDayReturn,
          volatility: market.volatility,
          rangePosition: market.rangePosition,
          provider: market.provider
        }
      ])
    ),
    nextWeights: rankedWeights,
    stats: {
      memberCount: scoredMembers.length,
      tickerCount: rankedWeights.length,
      medianScore,
      topTicker: topWeight,
      alphaLeader: topMember
        ? {
            name: topMember.name,
            compositeScore: topMember.compositeScore,
            sevenDayReturn: topMember.sevenDayReturn,
            projectedInfluence: topMember.projectedInfluence
          }
        : null,
      unityScore: rankedWeights.slice(0, 3).reduce((sum, holding) => sum + holding.weight, 0),
      diversityScore: rankedWeights.length
    },
    settlements: alpha.settlements || [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeAlphaSettings(settings = {}) {
  return {
    roundLengthDays: Number(settings.roundLengthDays || 7),
    lastRebalanceAt: String(settings.lastRebalanceAt || new Date().toISOString().slice(0, 10)),
    aggressiveness: Number(settings.aggressiveness || 8),
    minInfluence: Number(settings.minInfluence || 0.3),
    maxInfluence: Number(settings.maxInfluence || 3),
    smoothing: clamp(Number(settings.smoothing ?? 0.35), 0, 1),
    maxTickerWeight: clamp(Number(settings.maxTickerWeight || 0.35), 0.05, 1)
  };
}

function normalizeAlphaMember(member) {
  const picks = (Array.isArray(member.picks) ? member.picks : [])
    .map((pick) => {
      if (typeof pick === 'string') {
        return { symbol: normalizeTicker(pick), costBasis: null, costSource: 'legacy' };
      }

      return {
        symbol: normalizeTicker(pick.symbol),
        costBasis: normalizeCostBasis(pick.costBasis),
        costSource: pick.costSource || 'member'
      };
    })
    .filter((pick) => pick.symbol);
  const uniquePicks = [];

  for (const pick of picks) {
    if (!uniquePicks.some((entry) => entry.symbol === pick.symbol)) {
      uniquePicks.push(pick);
    }
  }

  return {
    name: String(member.name || '').trim(),
    influence: isPositiveNumber(member.influence) ? Number(member.influence) : 1,
    previousInfluence: isPositiveNumber(member.previousInfluence) ? Number(member.previousInfluence) : 1,
    picks: uniquePicks.slice(0, 2),
    joinedAt: member.joinedAt || null,
    updatedAt: member.updatedAt || null
  };
}

async function getAlphaMarketData(symbols) {
  const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await getSymbolMarketWindow(symbol)]));
  return Object.fromEntries(entries);
}

async function getSymbolMarketWindow(symbol) {
  const quote = await getQuote(symbol);

  if (!finnhubApiKey || quote.isDemo) {
    return makeDemoMarketWindow(symbol, quote);
  }

  try {
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - 18);
    const candles = await fetchCandles(symbol, Math.floor(fromDate.getTime() / 1000), Math.floor(toDate.getTime() / 1000));
    const dates = Object.keys(candles).sort();
    if (dates.length < 2) {
      return makeDemoMarketWindow(symbol, quote);
    }

    const targetDate = new Date(toDate);
    targetDate.setDate(targetDate.getDate() - 7);
    const targetKey = targetDate.toISOString().slice(0, 10);
    const baseDate = dates.filter((date) => date <= targetKey).at(-1) || dates[0];
    const closes = dates.map((date) => Number(candles[date])).filter((value) => isPositiveNumber(value));
    const price = quote.price;
    const sevenDayBase = Number(candles[baseDate]);
    const low = Math.min(...closes, price);
    const high = Math.max(...closes, price);

    return {
      symbol,
      price,
      sevenDayBase,
      sevenDayReturn: percentage(price - sevenDayBase, sevenDayBase) / 100,
      volatility: standardDeviation(closes.slice(1).map((close, index) => (close - closes[index]) / closes[index])),
      rangePosition: high > low ? (price - low) / (high - low) : 0.5,
      provider: 'finnhub'
    };
  } catch (error) {
    return makeDemoMarketWindow(symbol, quote);
  }
}

function makeDemoMarketWindow(symbol, quote) {
  const sevenDayReturn = demoSevenDayReturn(symbol);
  const sevenDayBase = quote.price / (1 + sevenDayReturn);
  const volatility = demoVolatility(symbol);

  return {
    symbol,
    price: quote.price,
    sevenDayBase,
    sevenDayReturn,
    volatility,
    rangePosition: clamp(0.54 + sevenDayReturn * 2.4, 0.05, 0.95),
    provider: quote.provider || 'demo'
  };
}

function enrichPick(pick, market) {
  const costBasis = isPositiveNumber(pick.costBasis) ? Number(pick.costBasis) : market.price;
  const sevenDayReturn = clamp(market.sevenDayReturn, -0.5, 0.5);
  const costReturn = clamp((market.price - costBasis) / costBasis, -0.5, 0.5);
  const volatility = clamp(market.volatility || 0, 0, 0.4);
  const chasePenalty = Math.max(0, (market.rangePosition || 0.5) - 0.72) * 0.12;
  const compositeScore = (sevenDayReturn * 0.42) + (costReturn * 0.42) - (volatility * 0.16) - chasePenalty;
  const qualityMultiplier = clamp(1 + compositeScore * 3, 0.65, 1.45);

  return {
    ...pick,
    costBasis,
    price: market.price,
    sevenDayBase: market.sevenDayBase,
    sevenDayReturn,
    costReturn,
    volatility,
    rangePosition: market.rangePosition,
    chasePenalty,
    compositeScore,
    qualityMultiplier
  };
}

function normalizeWeightMap(weightMap, fund) {
  const total = Object.values(weightMap).reduce((sum, value) => sum + Number(value || 0), 0);
  if (total <= 0) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(weightMap)
      .map(([symbol, value]) => [symbol, Number(value || 0) / total])
      .filter(([, value]) => value > 0)
      .map(([symbol, value]) => [describeSymbol(symbol, fund).symbol, value])
  );
}

function smoothWeights(currentWeights, consensusWeights, smoothing) {
  const symbols = [...new Set([...Object.keys(currentWeights), ...Object.keys(consensusWeights)])];
  const raw = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      Number(currentWeights[symbol] || 0) * (1 - smoothing) + Number(consensusWeights[symbol] || 0) * smoothing
    ])
  );

  return normalizeWeightMap(raw, { holdings: [] });
}

function capWeights(weightMap, maxWeight) {
  let weights = { ...weightMap };

  for (let pass = 0; pass < 8; pass += 1) {
    const capped = Object.entries(weights).filter(([, weight]) => weight > maxWeight);
    if (!capped.length) {
      break;
    }

    const excess = capped.reduce((sum, [, weight]) => sum + weight - maxWeight, 0);
    const receivers = Object.entries(weights).filter(([, weight]) => weight < maxWeight);
    const receiverTotal = receivers.reduce((sum, [, weight]) => sum + weight, 0);

    for (const [symbol] of capped) {
      weights[symbol] = maxWeight;
    }

    if (receiverTotal <= 0) {
      break;
    }

    for (const [symbol, weight] of receivers) {
      weights[symbol] = weight + excess * (weight / receiverTotal);
    }
  }

  return normalizeWeightMap(weights, { holdings: [] });
}

function describeSymbol(symbol, fund) {
  const holding = fund.holdings.find((entry) => entry.symbol === symbol);
  return {
    symbol,
    name: holding?.name || symbol,
    theme: holding?.theme || 'Community Pick'
  };
}

function demoSevenDayReturn(symbol) {
  const returns = {
    NVDA: 0.075,
    SNDK: 0.112,
    MU: 0.064,
    ORCL: 0.018,
    INTC: -0.021,
    GEV: 0.033,
    LITE: 0.058,
    QQQ: 0.016
  };

  if (symbol in returns) {
    return returns[symbol];
  }

  return ((hashSymbol(symbol) % 1300) - 400) / 10000;
}

function demoVolatility(symbol) {
  return 0.018 + (hashSymbol(symbol) % 90) / 5000;
}

function hashSymbol(symbol) {
  return [...symbol].reduce((hash, char) => hash + char.charCodeAt(0) * 17, 0);
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

function average(values) {
  const cleanValues = values.filter((value) => Number.isFinite(Number(value)));
  if (!cleanValues.length) {
    return 0;
  }

  return cleanValues.reduce((sum, value) => sum + Number(value), 0) / cleanValues.length;
}

function median(values) {
  const cleanValues = values
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number)
    .sort((a, b) => a - b);

  if (!cleanValues.length) {
    return 0;
  }

  const middle = Math.floor(cleanValues.length / 2);
  return cleanValues.length % 2
    ? cleanValues[middle]
    : (cleanValues[middle - 1] + cleanValues[middle]) / 2;
}

function standardDeviation(values) {
  const cleanValues = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (cleanValues.length < 2) {
    return 0;
  }

  const mean = average(cleanValues);
  const variance = average(cleanValues.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function daysBetween(startText, endText) {
  const start = new Date(`${startText}T00:00:00Z`);
  const end = new Date(`${endText}T00:00:00Z`);
  return Math.ceil((end - start) / 86400000);
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
