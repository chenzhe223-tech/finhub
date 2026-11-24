// Cloudflare Worker: 北京时间 08:30 (UTC 00:30) 与 15:00 (UTC 07:00) 自动抓取全市场数据
const SYMBOLS = [
  // 贵金属
  { id: 'gold',    ticker: 'GC=F' },
  { id: 'silver',  ticker: 'SI=F' },
  // 中美股指
  { id: 'sh',      ticker: '000001.SS' },
  { id: 'csi300',  ticker: '000300.SS' },
  { id: 'hsi',     ticker: '^HSI' },
  { id: 'spx',     ticker: '^GSPC' },
  { id: 'ixic',    ticker: '^IXIC' },
  { id: 'dji',     ticker: '^DJI' },
  // 美股 AI 与互联网龙头
  { id: 'aapl',    ticker: 'AAPL' },
  { id: 'nvda',    ticker: 'NVDA' },
  { id: 'msft',    ticker: 'MSFT' },
  { id: 'googl',   ticker: 'GOOGL' },
  { id: 'amzn',    ticker: 'AMZN' },
  { id: 'tsm',     ticker: 'TSM' },
  { id: 'meta',    ticker: 'META' },
  { id: 'baba',    ticker: 'BABA' },
  // 港股龙头
  { id: 'tcehy',   ticker: '0700.HK' },
  { id: 'baba_hk', ticker: '9988.HK' },
  { id: 'meituan', ticker: '3690.HK' },
  { id: 'xiaomi',  ticker: '1810.HK' },
  { id: 'smic',    ticker: '0981.HK' },
  // A 股核心资产与 AI 龙头
  { id: 'moutai',  ticker: '600519.SS' },
  { id: 'catl',    ticker: '300750.SZ' },
  { id: 'byd',     ticker: '002594.SZ' },
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAllMarketData(env));
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
    return env.ASSETS.fetch(request);
  }
};
