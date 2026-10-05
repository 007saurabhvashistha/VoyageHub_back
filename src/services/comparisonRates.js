import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, isCurrencyCode } from '../config/index.js';

const apiRatesSchema = z.array(z.object({
  date: z.iso.date(),
  base: z.string().refine(isCurrencyCode),
  quote: z.string().refine(isCurrencyCode),
  rate: z.number().positive().finite(),
}));
const caches = new WeakMap();

function currencyDigits(currency) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

export function convertMinorUnits(amountMinor, rate, baseCurrency, quoteCurrency) {
  if (!Number.isSafeInteger(amountMinor) || !Number.isFinite(rate) || rate <= 0) return null;
  const baseScale = 10 ** currencyDigits(baseCurrency);
  const quoteScale = 10 ** currencyDigits(quoteCurrency);
  const converted = Math.round((amountMinor / baseScale) * rate * quoteScale);
  return Number.isSafeInteger(converted) ? converted : null;
}

async function storedRate(db, baseCurrency, quoteCurrency) {
  const result = await db.query(
    `SELECT base_currency, quote_currency, rate, rate_date, fetched_at, provider
     FROM comparison_exchange_rates WHERE base_currency = $1 AND quote_currency = $2
     ORDER BY rate_date DESC, fetched_at DESC LIMIT 1`,
    [baseCurrency, quoteCurrency],
  );
  const row = result.rows[0];
  return row ? {
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rate: Number(row.rate),
    rateDate: row.rate_date instanceof Date ? row.rate_date.toISOString().slice(0, 10) : String(row.rate_date).slice(0, 10),
    fetchedAt: row.fetched_at,
    provider: row.provider,
    stale: true,
  } : null;
}

async function fetchRate(db, baseCurrency, quoteCurrency, { fetchImpl, now }) {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const key = `${baseCurrency}:${quoteCurrency}`;
  const cached = cache.get(key);
  if (cached && now().getTime() - cached.cachedAt < config.comparisonRates.cacheMs) return cached.value;

  const url = new URL(`${config.comparisonRates.apiUrl}/rates`);
  url.searchParams.set('base', baseCurrency);
  url.searchParams.set('quotes', quoteCurrency);
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.comparisonRates.timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Rate provider returned ${response.status}.`);
    const parsed = apiRatesSchema.safeParse(await response.json());
    const row = parsed.success ? parsed.data.find((item) => item.base === baseCurrency && item.quote === quoteCurrency) : null;
    if (!row) throw new Error('Rate provider returned no matching currency pair.');
    const value = {
      baseCurrency,
      quoteCurrency,
      rate: row.rate,
      rateDate: row.date,
      fetchedAt: now().toISOString(),
      provider: 'Frankfurter',
      stale: false,
    };
    await db.query(
      `INSERT INTO comparison_exchange_rates (id, base_currency, quote_currency, rate, rate_date, fetched_at, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (base_currency, quote_currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at, provider = EXCLUDED.provider`,
      [randomUUID(), baseCurrency, quoteCurrency, row.rate, row.date, value.fetchedAt, value.provider],
    );
    cache.set(key, { value, cachedAt: now().getTime() });
    return value;
  } catch {
    const fallback = await storedRate(db, baseCurrency, quoteCurrency);
    if (fallback) return fallback;
    return null;
  }
}

export async function loadComparisonRates(db, currencies, {
  quoteCurrency = config.defaultCurrency,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const uniqueCurrencies = [...new Set(currencies.map((currency) => String(currency).trim().toUpperCase()))];
  const pairs = await Promise.all(uniqueCurrencies.map(async (baseCurrency) => {
    if (!isCurrencyCode(baseCurrency)) return [baseCurrency, null];
    if (baseCurrency === quoteCurrency) return [baseCurrency, {
      baseCurrency, quoteCurrency, rate: 1, rateDate: now().toISOString().slice(0, 10), fetchedAt: now().toISOString(), provider: 'identity', stale: false,
    }];
    return [baseCurrency, await fetchRate(db, baseCurrency, quoteCurrency, { fetchImpl, now })];
  }));
  return new Map(pairs);
}
