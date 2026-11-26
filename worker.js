// Cloudflare Worker: 北京时间 08:30 (UTC 00:30) 与 15:00 (UTC 07:00) 自动抓取全市场数据
const SYMBOLS = [
  // 贵金属
  { id: 'gold',      ticker: 'GC=F' },
  { id: 'silver',    ticker: 'SI=F' },
  // 中美股指
  { id: 'sh',        ticker: '000001.SS' },
  { id: 'csi300',    ticker: '000300.SS' },
  { id: 'hsi',       ticker: '^HSI' },
  { id: 'spx',       ticker: '^GSPC' },
  { id: 'ixic',      ticker: '^IXIC' },
  { id: 'dji',       ticker: '^DJI' },
  // 美股 AI 与互联网龙头
  { id: 'aapl',      ticker: 'AAPL' },
  { id: 'nvda',      ticker: 'NVDA' },
  { id: 'msft',      ticker: 'MSFT' },
  { id: 'googl',     ticker: 'GOOGL' },
  { id: 'amzn',      ticker: 'AMZN' },
  { id: 'tsm',       ticker: 'TSM' },
  { id: 'meta',      ticker: 'META' },
  { id: 'anth',      ticker: 'ANT' },
  { id: 'baba',      ticker: 'BABA' },
  // 港股龙头
  { id: 'tcehy',     ticker: '0700.HK' },
  { id: 'baba_hk',   ticker: '9988.HK' },
  { id: 'meituan',   ticker: '3690.HK' },
  { id: 'xiaomi',    ticker: '1810.HK' },
  { id: 'smic',      ticker: '0981.HK' },
  // A 股核心资产与 AI 龙头
  { id: 'moutai',    ticker: '600519.SS' },
  { id: 'catl',      ticker: '300750.SZ' },
  { id: 'byd',       ticker: '002594.SZ' },
  { id: 'innolight', ticker: '300308.SZ' },
  { id: 'cambricon', ticker: '688256.SS' }
];

const FX_TICKERS = [
  { code: 'USD', ticker: 'USDCNY=X', unit: 1 },
  { code: 'EUR', ticker: 'EURCNY=X', unit: 1 },
  { code: 'JPY', ticker: 'JPYCNY=X', unit: 100 },
  { code: 'HKD', ticker: 'HKDCNY=X', unit: 1 },
  { code: 'GBP', ticker: 'GBPCNY=X', unit: 1 },
  { code: 'AUD', ticker: 'AUDCNY=X', unit: 1 },
  { code: 'CAD', ticker: 'CADCNY=X', unit: 1 },
  { code: 'SGD', ticker: 'SGDCNY=X', unit: 1 }
];

async function fetchYahooChart(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=15m`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ticker}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Empty result for ${ticker}`);

  const meta = result.meta || {};
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number' && !isNaN(v));
  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[0] ?? price;
  const high = meta.regularMarketDayHigh ?? (closes.length ? Math.max(...closes, price) : price);
  const low = meta.regularMarketDayLow ?? (closes.length ? Math.min(...closes, price) : price);
  const series = closes.length >= 4 ? closes.slice(-26) : [prevClose, price];

  return {
    price: Number(price),
    prevClose: Number(prevClose),
    high: Number(high),
    low: Number(low),
    series: series.map(n => Number(n.toFixed(4)))
  };
}

async function refreshAllMarketData(env) {
  const assets = {};
  const fx = {};

  await Promise.allSettled(
    SYMBOLS.map(async (item) => {
      try {
        assets[item.id] = await fetchYahooChart(item.ticker);
      } catch (err) {
        console.error(`Asset fetch failed [${item.id}]:`, err.message);
      }
    })
  );

  let frankfurterRates = null;
  try {
    const fRes = await fetch('https://api.frankfurter.app/latest?from=CNY&to=USD,EUR,JPY,HKD,GBP,AUD,CAD,SGD');
    if (fRes.ok) {
      const fJson = await fRes.json();
      frankfurterRates = fJson?.rates || null;
    }
  } catch (e) {}

  await Promise.allSettled(
    FX_TICKERS.map(async (item) => {
      try {
        const q = await fetchYahooChart(item.ticker);
        fx[item.code] = {
          rate: Number((q.price * item.unit).toFixed(4)),
          prevClose: Number((q.prevClose * item.unit).toFixed(4)),
          high: Number((q.high * item.unit).toFixed(4)),
          low: Number((q.low * item.unit).toFixed(4)),
          series: q.series.map(v => Number((v * item.unit).toFixed(4)))
        };
      } catch (err) {
        if (frankfurterRates && frankfurterRates[item.code]) {
          const r = (1 / frankfurterRates[item.code]) * item.unit;
          fx[item.code] = {
            rate: Number(r.toFixed(4)),
            prevClose: Number(r.toFixed(4)),
            high: Number(r.toFixed(4)),
            low: Number(r.toFixed(4)),
            series: [Number(r.toFixed(4)), Number(r.toFixed(4))]
          };
        }
      }
    })
  );

  let existing = {};
  if (env.MARKET_KV) {
    try {
      const oldRaw = await env.MARKET_KV.get('latest_snapshot');
      if (oldRaw) existing = JSON.parse(oldRaw);
    } catch (e) {}
  }

  const nowBjt = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const updatedAt = `${nowBjt.getUTCFullYear()}-${pad(nowBjt.getUTCMonth() + 1)}-${pad(nowBjt.getUTCDate())} ${pad(nowBjt.getUTCHours())}:${pad(nowBjt.getUTCMinutes())} (GMT+8)`;

  const payload = {
    updatedAt,
    source: 'Cloudflare Cron (08:30 / 15:00 BJT)',
    assets: { ...(existing.assets || {}), ...assets },
    fx: { ...(existing.fx || {}), ...fx }
  };

  if (env.MARKET_KV && (Object.keys(assets).length > 0 || Object.keys(fx).length > 0)) {
    await env.MARKET_KV.put('latest_snapshot', JSON.stringify(payload));
  }
  return payload;
}

// 世界银行 WDI 宏观指标配置 (58 个核心经济体, 2016-2025 实际统计)
const WB_ISO3_LIST = [
  'USA','CHN','DEU','JPN','IND','GBR','FRA','ITA','BRA','CAN','RUS','KOR','AUS','MEX','IDN','SAU',
  'ESP','NLD','TUR','CHE','POL','BEL','ARG','SWE','IRL','ARE','SGP','ISR','THA','AUT','NOR','VNM',
  'PHL','MYS','BGD','DNK','COL','ZAF','EGY','ROU','PAK','CHL','CZE','FIN','PRT','PER','KAZ','NZL',
  'GRC','NGA','QAT','HUN','UKR','ETH','MAR','KEN','LUX','ISL'
];
const WB_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const WB_INDICATORS = [
  { key: 'gdp',          code: 'NY.GDP.MKTP.CD',    scale: 1e-12, digits: 2 },
  { key: 'gdpPerCapita', code: 'NY.GDP.PCAP.CD',    scale: 1,     digits: 0 },
  { key: 'growth',       code: 'NY.GDP.MKTP.KD.ZG', scale: 1,     digits: 1 },
  { key: 'pppPerCapita', code: 'NY.GDP.PCAP.PP.CD', scale: 1,     digits: 0 }
];
const CORE_ISO3_TO_ID = {
  USA:'us', CHN:'cn', DEU:'de', JPN:'jp', IND:'in', GBR:'uk', FRA:'fr', ITA:'it',
  BRA:'br', CAN:'ca', RUS:'ru', KOR:'kr', AUS:'au', MEX:'mx', IDN:'id', SAU:'sa'
};

async function fetchWorldBankIndicator(indicatorCode) {
  const isoQuery = WB_ISO3_LIST.join(';');
  const url = `https://api.worldbank.org/v2/country/${isoQuery}/indicator/${indicatorCode}?date=2016:2025&format=json&per_page=2000`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DAVYLAB-FinHub-Worker/1.0' }
  });
  if (!res.ok) throw new Error(`WorldBank HTTP ${res.status} for ${indicatorCode}`);
  const json = await res.json();
  const rows = Array.isArray(json) && Array.isArray(json[1]) ? json[1] : [];
  const byIso = {};
  for (const row of rows) {
    const iso3 = row?.countryiso3code;
    const yr = Number(row?.date);
    const val = row?.value;
    if (!iso3 || !Number.isFinite(yr) || val === null || val === undefined || isNaN(Number(val))) continue;
    if (!byIso[iso3]) byIso[iso3] = {};
    byIso[iso3][yr] = Number(val);
  }
  return byIso;
}

async function refreshWorldBankMacroData(env) {
  const results = await Promise.allSettled(
    WB_INDICATORS.map(async (ind) => ({ ind, data: await fetchWorldBankIndicator(ind.code) }))
  );

  const countries = {};
  let latestActualYear = 2023;
  let populatedCount = 0;

  for (const item of results) {
    if (item.status !== 'fulfilled') {
      console.error('WorldBank indicator failed:', item.reason?.message || item.reason);
      continue;
    }
    const { ind, data } = item.value;
    for (const iso3 of WB_ISO3_LIST) {
      const yrMap = data[iso3];
      if (!yrMap) continue;
      if (!countries[iso3]) countries[iso3] = {};
      const series = WB_YEARS.map((yr) => {
        const raw = yrMap[yr];
        if (raw === undefined || raw === null) return null;
        if (yr > latestActualYear) latestActualYear = yr;
        const scaled = raw * ind.scale;
        return ind.digits === 0 ? Math.round(scaled) : Number(scaled.toFixed(ind.digits));
      });
      if (series.some(v => v !== null)) {
        countries[iso3][ind.key] = series;
        populatedCount++;
      }
    }
  }

  if (populatedCount === 0) {
    return null;
  }

  const nowBjt = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const updatedAt = `${nowBjt.getUTCFullYear()}-${pad(nowBjt.getUTCMonth() + 1)}-${pad(nowBjt.getUTCDate())} ${pad(nowBjt.getUTCHours())}:${pad(nowBjt.getUTCMinutes())} (GMT+8)`;

  const gdp10y = Object.entries(CORE_ISO3_TO_ID)
    .filter(([iso3]) => countries[iso3]?.gdp)
    .map(([iso3, id]) => ({
      id,
      iso3,
      nom: countries[iso3].gdp,
      gr: countries[iso3].growth || null,
      pc10y: countries[iso3].gdpPerCapita || null
    }));

  const payload = {
    updatedAt,
    fetchedAtMs: Date.now(),
    source: `World Bank WDI API (实际统计截至 ${latestActualYear}, 2026E 沿用 IMF WEO 预测)`,
    meta: {
      source: `World Bank Open Data API (WDI, 截至 ${latestActualYear}) + IMF WEO 2026E`,
      sourceEn: `World Bank Open Data API (WDI through ${latestActualYear}) + IMF WEO 2026E`,
      isDemo: false,
      asOfYear: 2026,
      actualThroughYear: latestActualYear,
      updatedAt,
      countryCount: Object.keys(countries).length,
      methodologyNote: `口径：GDP（NY.GDP.MKTP.CD）与人均 GDP（NY.GDP.PCAP.CD）为现价美元；增速为实际同比（NY.GDP.MKTP.KD.ZG）；PPP 人均为购买力平价现价国际元（NY.GDP.PCAP.PP.CD）。真实数据截至 ${latestActualYear} 年，缺口年份由基准预测补齐。`
    },
    years: WB_YEARS,
    countries,
    gdp10y
  };

  if (env.MARKET_KV) {
    await env.MARKET_KV.put('latest_macro_wb', JSON.stringify(payload));
  }
  return payload;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await refreshAllMarketData(env);
      // 宏观数据每日最多自动刷新一次，避免高频请求世界银行接口
      if (env.MARKET_KV) {
        try {
          const cached = await env.MARKET_KV.get('latest_macro_wb', { type: 'json' });
          const ageMs = cached?.fetchedAtMs ? (Date.now() - cached.fetchedAtMs) : Infinity;
          if (ageMs > 24 * 3600 * 1000) {
            await refreshWorldBankMacroData(env);
          }
        } catch (e) {
          console.error('Macro cron check failed:', e.message);
        }
      }
    })());
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/market') {
      const force = url.searchParams.get('force') === '1';
      let data = null;
      if (!force && env.MARKET_KV) {
        data = await env.MARKET_KV.get('latest_snapshot', { type: 'json' });
      }
      if (!data) {
        data = await refreshAllMarketData(env);
      }
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60'
        }
      });
    }
    if (url.pathname === '/api/macro') {
      const force = url.searchParams.get('force') === '1';
      let data = null;
      if (!force && env.MARKET_KV) {
        data = await env.MARKET_KV.get('latest_macro_wb', { type: 'json' });
      }
      if (!data) {
        try {
          data = await refreshWorldBankMacroData(env);
        } catch (err) {
          console.error('WorldBank fetch failed:', err.message);
        }
      }
      if (!data) {
        return new Response(JSON.stringify({ ok: false, fallback: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1800'
        }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
