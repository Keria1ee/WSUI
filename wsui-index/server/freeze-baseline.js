import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const fundPath = path.join(rootDir, 'data', 'fund.json');

await loadDotEnv();

const finnhubApiKey = process.env.FINNHUB_API_KEY || '';
if (!finnhubApiKey) {
  console.error('FINNHUB_API_KEY is required to freeze real inception prices.');
  process.exit(1);
}

const fund = JSON.parse(await readFile(fundPath, 'utf8'));
const symbols = [...new Set([...fund.holdings.map((holding) => holding.symbol), fund.benchmark.symbol])];
const priceEntries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchCurrentPrice(symbol)]));
const prices = Object.fromEntries(priceEntries);

const nextFund = {
  ...fund,
  benchmark: {
    ...fund.benchmark,
    inceptionPrice: prices[fund.benchmark.symbol]
  },
  holdings: fund.holdings.map((holding) => ({
    ...holding,
    inceptionPrice: prices[holding.symbol]
  }))
};

await writeFile(fundPath, `${JSON.stringify(nextFund, null, 2)}\n`, 'utf8');

console.log('Frozen WSUI inception prices:');
for (const symbol of symbols) {
  console.log(`${symbol}: ${prices[symbol]}`);
}

async function fetchCurrentPrice(symbol) {
  const url = new URL('https://finnhub.io/api/v1/quote');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', finnhubApiKey);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub quote request failed for ${symbol} with ${response.status}`);
  }

  const data = await response.json();
  if (!Number.isFinite(Number(data.c)) || Number(data.c) <= 0) {
    throw new Error(`Finnhub returned no current price for ${symbol}`);
  }

  return Number(data.c);
}

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
