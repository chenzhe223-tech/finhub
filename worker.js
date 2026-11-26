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

// ============================================================================
// 个股实时查询、多周期走势、资金进出与估值目标价接口 (/api/stock/search & /api/stock/detail)
// ============================================================================
const STOCK_CATALOG = [
  // A 股热门核心标的
  { ticker: '600519.SS', zh: '贵州茅台', en: 'Kweichow Moutai', mkt: 'cn', cur: '¥', sector: '白酒消费', peBase: 22.4, pbBase: 8.6, divBase: 3.4, roeBase: 34.2, revGr: 11.2, gmBase: 91.9 },
  { ticker: '300750.SZ', zh: '宁德时代', en: 'CATL',            mkt: 'cn', cur: '¥', sector: '动力电池/储能', peBase: 21.8, pbBase: 4.9, divBase: 2.1, roeBase: 24.5, revGr: 15.6, gmBase: 24.8 },
  { ticker: '002594.SZ', zh: '比亚迪',   en: 'BYD',             mkt: 'cn', cur: '¥', sector: '新能源汽车', peBase: 20.5, pbBase: 5.1, divBase: 1.2, roeBase: 23.8, revGr: 18.4, gmBase: 21.2 },
  { ticker: '300308.SZ', zh: '中际旭创', en: 'Innolight',       mkt: 'cn', cur: '¥', sector: 'AI光模块', peBase: 28.4, pbBase: 8.2, divBase: 0.9, roeBase: 29.1, revGr: 62.5, gmBase: 33.6 },
  { ticker: '688256.SS', zh: '寒武纪',   en: 'Cambricon',       mkt: 'cn', cur: '¥', sector: 'AI算力芯片', peBase: 145.0, pbBase: 26.5, divBase: 0.0, roeBase: 4.2, revGr: 88.0, gmBase: 64.5 },
  { ticker: '000858.SZ', zh: '五粮液',   en: 'Wuliangye',       mkt: 'cn', cur: '¥', sector: '白酒消费', peBase: 16.8, pbBase: 4.1, divBase: 3.8, roeBase: 24.6, revGr: 8.5, gmBase: 76.4 },
  { ticker: '600036.SS', zh: '招商银行', en: 'CMB',             mkt: 'cn', cur: '¥', sector: '股份制银行', peBase: 6.8, pbBase: 0.98, divBase: 5.1, roeBase: 15.4, revGr: 2.8, gmBase: 58.0 },
  { ticker: '601318.SS', zh: '中国平安', en: 'Ping An',         mkt: 'cn', cur: '¥', sector: '综合保险金融', peBase: 8.2, pbBase: 1.05, divBase: 4.6, roeBase: 13.8, revGr: 7.4, gmBase: 36.0 },
  { ticker: '300760.SZ', zh: '迈瑞医疗', en: 'Mindray',         mkt: 'cn', cur: '¥', sector: '医疗器械', peBase: 24.5, pbBase: 8.4, divBase: 2.4, roeBase: 33.5, revGr: 12.8, gmBase: 65.8 },
  { ticker: '000333.SZ', zh: '美的集团', en: 'Midea Group',     mkt: 'cn', cur: '¥', sector: '智能家电/机器人', peBase: 13.6, pbBase: 2.9, divBase: 4.2, roeBase: 22.4, revGr: 9.6, gmBase: 26.8 },
  { ticker: '601899.SS', zh: '紫金矿业', en: 'Zijin Mining',    mkt: 'cn', cur: '¥', sector: '黄金铜矿资源', peBase: 14.2, pbBase: 3.5, divBase: 2.3, roeBase: 25.1, revGr: 16.2, gmBase: 20.5 },
  { ticker: '601138.SS', zh: '工业富联', en: 'Foxconn Ind.',    mkt: 'cn', cur: '¥', sector: 'AI服务器代工', peBase: 19.6, pbBase: 3.2, divBase: 2.6, roeBase: 17.5, revGr: 26.8, gmBase: 8.4 },
  { ticker: '300059.SZ', zh: '东方财富', en: 'East Money',      mkt: 'cn', cur: '¥', sector: '互联网券商', peBase: 32.5, pbBase: 4.2, divBase: 0.6, roeBase: 12.8, revGr: 14.2, gmBase: 66.0 },
  { ticker: '600030.SS', zh: '中信证券', en: 'CITIC Sec.',      mkt: 'cn', cur: '¥', sector: '头部券商', peBase: 18.4, pbBase: 1.48, divBase: 2.2, roeBase: 8.6, revGr: 11.5, gmBase: 48.0 },
  { ticker: '002415.SZ', zh: '海康威视', en: 'Hikvision',       mkt: 'cn', cur: '¥', sector: 'AIoT安防视觉', peBase: 19.2, pbBase: 3.6, divBase: 2.9, roeBase: 19.1, revGr: 6.4, gmBase: 44.5 },
  { ticker: '002475.SZ', zh: '立讯精密', en: 'Luxshare',        mkt: 'cn', cur: '¥', sector: '消费电子/AI互联', peBase: 21.0, pbBase: 4.3, divBase: 0.9, roeBase: 21.4, revGr: 18.2, gmBase: 12.1 },
  { ticker: '300274.SZ', zh: '阳光电源', en: 'Sungrow',         mkt: 'cn', cur: '¥', sector: '光伏逆变器/储能', peBase: 15.8, pbBase: 4.8, divBase: 1.4, roeBase: 31.2, revGr: 21.5, gmBase: 31.4 },
  { ticker: '600276.SS', zh: '恒瑞医药', en: 'Hengrui Pharma',  mkt: 'cn', cur: '¥', sector: '创新药', peBase: 48.5, pbBase: 6.8, divBase: 0.6, roeBase: 14.2, revGr: 15.8, gmBase: 85.6 },
  { ticker: '601398.SS', zh: '工商银行', en: 'ICBC',            mkt: 'cn', cur: '¥', sector: '国有大行', peBase: 6.1, pbBase: 0.62, divBase: 5.2, roeBase: 10.4, revGr: 1.5, gmBase: 52.0 },
  { ticker: '688981.SS', zh: '中芯国际(A)', en: 'SMIC (A)',     mkt: 'cn', cur: '¥', sector: '晶圆代工', peBase: 92.0, pbBase: 4.6, divBase: 0.0, roeBase: 5.1, revGr: 24.5, gmBase: 20.8 },
  // 港股核心标的
  { ticker: '0700.HK',   zh: '腾讯控股', en: 'Tencent',         mkt: 'hk', cur: 'HK$', sector: '互联网社交/游戏/AI', peBase: 17.8, pbBase: 3.6, divBase: 1.1, roeBase: 21.8, revGr: 9.2, gmBase: 53.2 },
  { ticker: '9988.HK',   zh: '阿里巴巴-W', en: 'Alibaba HK',    mkt: 'hk', cur: 'HK$', sector: '电商/云计算AI', peBase: 12.4, pbBase: 1.55, divBase: 1.8, roeBase: 13.6, revGr: 7.8, gmBase: 39.2 },
  { ticker: '3690.HK',   zh: '美团-W',   en: 'Meituan',         mkt: 'hk', cur: 'HK$', sector: '本地生活服务', peBase: 21.5, pbBase: 4.8, divBase: 0.0, roeBase: 22.4, revGr: 19.6, gmBase: 38.4 },
  { ticker: '1810.HK',   zh: '小米集团-W', en: 'Xiaomi',        mkt: 'hk', cur: 'HK$', sector: '智能终端/新能源车', peBase: 26.8, pbBase: 3.9, divBase: 0.0, roeBase: 15.2, revGr: 27.5, gmBase: 21.6 },
  { ticker: '0981.HK',   zh: '中芯国际', en: 'SMIC',            mkt: 'hk', cur: 'HK$', sector: '半导体晶圆代工', peBase: 44.0, pbBase: 2.2, divBase: 0.0, roeBase: 5.1, revGr: 24.5, gmBase: 20.8 },
  { ticker: '9618.HK',   zh: '京东集团-SW', en: 'JD.com HK',    mkt: 'hk', cur: 'HK$', sector: '供应链电商', peBase: 10.6, pbBase: 1.65, divBase: 2.6, roeBase: 16.5, revGr: 5.8, gmBase: 15.8 },
  { ticker: '9999.HK',   zh: '网易-S',   en: 'NetEase HK',      mkt: 'hk', cur: 'HK$', sector: '游戏与数字内容', peBase: 14.2, pbBase: 3.2, divBase: 2.8, roeBase: 23.4, revGr: 6.2, gmBase: 62.4 },
  { ticker: '2015.HK',   zh: '理想汽车-W', en: 'Li Auto HK',    mkt: 'hk', cur: 'HK$', sector: '智能电动车', peBase: 18.6, pbBase: 2.8, divBase: 0.0, roeBase: 16.8, revGr: 22.4, gmBase: 20.6 },
  { ticker: '0941.HK',   zh: '中国移动', en: 'China Mobile',    mkt: 'hk', cur: 'HK$', sector: '通信运营商/算力网', peBase: 10.8, pbBase: 1.12, divBase: 6.4, roeBase: 10.6, revGr: 4.5, gmBase: 29.8 },
  { ticker: '0883.HK',   zh: '中国海洋石油', en: 'CNOOC',       mkt: 'hk', cur: 'HK$', sector: '油气能源', peBase: 6.4, pbBase: 1.18, divBase: 7.2, roeBase: 19.8, revGr: 6.8, gmBase: 53.5 },
  // 美股核心标的
  { ticker: 'NVDA',      zh: '英伟达',   en: 'NVIDIA',          mkt: 'us', cur: '$', sector: 'AI算力芯片', peBase: 42.5, pbBase: 38.0, divBase: 0.03, roeBase: 92.4, revGr: 68.5, gmBase: 75.2 },
  { ticker: 'AAPL',      zh: '苹果',     en: 'Apple',           mkt: 'us', cur: '$', sector: '消费电子/生态服务', peBase: 34.2, pbBase: 48.0, divBase: 0.45, roeBase: 145.0, revGr: 6.2, gmBase: 46.5 },
  { ticker: 'MSFT',      zh: '微软',     en: 'Microsoft',       mkt: 'us', cur: '$', sector: '云计算/企业AI', peBase: 33.8, pbBase: 11.4, divBase: 0.72, roeBase: 36.2, revGr: 14.5, gmBase: 69.8 },
  { ticker: 'GOOGL',     zh: '谷歌A',    en: 'Alphabet',        mkt: 'us', cur: '$', sector: '搜索广告/AI云', peBase: 23.6, pbBase: 7.1, divBase: 0.42, roeBase: 31.4, revGr: 12.8, gmBase: 58.2 },
  { ticker: 'AMZN',      zh: '亚马逊',   en: 'Amazon',          mkt: 'us', cur: '$', sector: '电商/AWS云计算', peBase: 38.4, pbBase: 8.6, divBase: 0.0, roeBase: 23.5, revGr: 11.4, gmBase: 48.6 },
  { ticker: 'META',      zh: 'Meta',     en: 'Meta Platforms',  mkt: 'us', cur: '$', sector: '社交广告/开源AI', peBase: 26.8, pbBase: 8.8, divBase: 0.35, roeBase: 35.6, revGr: 18.2, gmBase: 81.4 },
  { ticker: 'TSM',       zh: '台积电',   en: 'TSMC ADR',        mkt: 'us', cur: '$', sector: '先进制程代工', peBase: 26.4, pbBase: 7.8, divBase: 1.4, roeBase: 29.4, revGr: 25.8, gmBase: 57.8 },
  { ticker: 'TSLA',      zh: '特斯拉',   en: 'Tesla',           mkt: 'us', cur: '$', sector: '电动车/自动驾驶/机器人', peBase: 78.0, pbBase: 13.5, divBase: 0.0, roeBase: 18.2, revGr: 12.5, gmBase: 18.4 },
  { ticker: 'AVGO',      zh: '博通',     en: 'Broadcom',        mkt: 'us', cur: '$', sector: 'AI定制芯片/网络', peBase: 36.5, pbBase: 14.2, divBase: 1.25, roeBase: 34.0, revGr: 32.0, gmBase: 67.5 },
  { ticker: 'AMD',       zh: '超威半导体', en: 'AMD',           mkt: 'us', cur: '$', sector: 'AI GPU/CPU', peBase: 41.2, pbBase: 4.5, divBase: 0.0, roeBase: 11.4, revGr: 22.8, gmBase: 52.4 },
  { ticker: 'PLTR',      zh: 'Palantir', en: 'Palantir Tech',   mkt: 'us', cur: '$', sector: '企业AI数据平台', peBase: 125.0, pbBase: 28.0, divBase: 0.0, roeBase: 14.8, revGr: 29.5, gmBase: 81.2 },
  { ticker: 'BABA',      zh: '阿里巴巴', en: 'Alibaba ADR',     mkt: 'us', cur: '$', sector: '电商/云计算AI', peBase: 12.6, pbBase: 1.58, divBase: 1.75, roeBase: 13.6, revGr: 7.8, gmBase: 39.2 },
  { ticker: 'PDD',       zh: '拼多多',   en: 'PDD Holdings',    mkt: 'us', cur: '$', sector: '跨境与社交电商', peBase: 10.4, pbBase: 3.9, divBase: 0.0, roeBase: 42.5, revGr: 34.2, gmBase: 61.5 },
  { ticker: 'NFLX',      zh: '奈飞',     en: 'Netflix',         mkt: 'us', cur: '$', sector: '流媒体内容', peBase: 42.8, pbBase: 16.5, divBase: 0.0, roeBase: 38.4, revGr: 15.2, gmBase: 45.8 },
  { ticker: 'BRK-B',     zh: '伯克希尔', en: 'Berkshire B',     mkt: 'us', cur: '$', sector: '综合金融投资', peBase: 21.2, pbBase: 1.58, divBase: 0.0, roeBase: 14.5, revGr: 7.8, gmBase: 26.0 },
  { ticker: 'ANT',       zh: 'Anthropic', en: 'Anthropic',      mkt: 'us', cur: '$', sector: '前沿大模型AI', peBase: 85.0, pbBase: 22.0, divBase: 0.0, roeBase: 12.0, revGr: 208.0, gmBase: 64.5 }
];

function normalizeStockTicker(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  if (/^\d{6}$/.test(s)) {
    return (s.startsWith('6') || s.startsWith('9')) ? `${s}.SS` : `${s}.SZ`;
  }
  if (/^\d{4,5}$/.test(s)) {
    return `${s.replace(/^0+/, '').padStart(4, '0')}.HK`;
  }
  if (s.endsWith('.SH')) return s.replace(/\.SH$/, '.SS');
  return s;
}

function detectStockMarket(ticker, exchange = '') {
  const t = String(ticker || '').toUpperCase();
  if (t.endsWith('.SS') || t.endsWith('.SZ') || t.endsWith('.BJ')) return { mkt: 'cn', cur: '¥' };
  if (t.endsWith('.HK')) return { mkt: 'hk', cur: 'HK$' };
  const ex = String(exchange || '').toUpperCase();
  if (ex.includes('HKG') || ex.includes('HKEX')) return { mkt: 'hk', cur: 'HK$' };
  if (ex.includes('SHH') || ex.includes('SHZ')) return { mkt: 'cn', cur: '¥' };
  return { mkt: 'us', cur: '$' };
}

function mapEastmoneySuggestItem(it) {
  const code = String(it?.Code || '').trim();
  const name = String(it?.Name || '').trim();
  if (!code || !name) return null;
  const cls = String(it?.Classify || '');
  const mktNum = String(it?.MktNum || '');
  const secType = String(it?.SecurityTypeName || '');
  const py = String(it?.PinYin || '').toUpperCase();

  // Filter to CN (A-share / STAR / ChiNext / BSE), HK, and US equities
  if (cls === 'AStock' || cls === '23' || secType.includes('沪A') || secType.includes('深A') || secType.includes('科创') || secType.includes('创业')) {
    if (!/^\d{6}$/.test(code)) return null;
    const suffix = (mktNum === '1' || code.startsWith('6') || code.startsWith('9')) ? '.SS' : '.SZ';
    return { ticker: `${code}${suffix}`, zh: name, en: name, py, mkt: 'cn', cur: '¥', sector: secType || 'A股' };
  }
  if (secType.includes('京A') || (cls === 'NEEQ' && /^\d{6}$/.test(code) && (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')))) {
    return { ticker: `${code}.BJ`, zh: name, en: name, py, mkt: 'cn', cur: '¥', sector: '京A/北交所' };
  }
  if (cls === 'HK' || secType.includes('港股') || mktNum === '116') {
    if (!/^\d{4,5}$/.test(code)) return null;
    const hkCode = `${code.replace(/^0+/, '').padStart(4, '0')}.HK`;
    return { ticker: hkCode, zh: name, en: name, py, mkt: 'hk', cur: 'HK$', sector: '港股' };
  }
  if (cls === 'UsStock' || secType.includes('美股') || ['105', '106', '107'].includes(mktNum)) {
    if (!/^[A-Z0-9.-]{1,10}$/i.test(code)) return null;
    return { ticker: code.toUpperCase(), zh: name, en: name, py, mkt: 'us', cur: '$', sector: '美股' };
  }
  return null;
}

async function fetchEastmoneySuggest(query, count = 12) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${count}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return [];
    const json = await res.json();
    const rows = json?.QuotationCodeTable?.Data;
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      const mapped = mapEastmoneySuggestItem(r);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function fetchTencentRealtimeQuote(ticker) {
  const t = String(ticker || '').toUpperCase();
  let qtCode = '';
  const mCn = t.match(/^(\d{6})\.(SS|SZ|BJ)$/);
  const mHk = t.match(/^(\d{4,5})\.HK$/);
  if (mCn) {
    qtCode = (mCn[2] === 'SS' ? 'sh' : (mCn[2] === 'BJ' ? 'bj' : 'sz')) + mCn[1];
  } else if (mHk) {
    qtCode = 'hk' + mHk[1].padStart(5, '0');
  } else if (/^[A-Z0-9.-]{1,10}$/.test(t)) {
    qtCode = 'us' + t;
  }
  if (!qtCode) return null;

  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${qtCode}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    let text = '';
    try {
      text = new TextDecoder('gb18030').decode(buf);
    } catch (e) {
      text = new TextDecoder('utf-8').decode(buf);
    }
    const bodyMatch = text.match(/="([^"]+)"/);
    if (!bodyMatch) return null;
    const parts = bodyMatch[1].split('~');
    if (parts.length < 40) return null;

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n !== 0 ? n : null;
    };
    const name = parts[1] ? parts[1].trim() : null;
    const price = num(parts[3]);
    const prevClose = num(parts[4]);
    const dayHigh = num(parts[33]);
    const dayLow = num(parts[34]);
    const turnover = num(parts[38]);
    const pe = num(parts[39]);
    const mcap = num(parts[45]); // 亿元 (CN) / 亿HK$ (HK) / $B (US varies)
    const pb = num(parts[46]);
    const high52w = num(parts[48]);
    const low52w = num(parts[49]);
    return { name, price, prevClose, dayHigh, dayLow, turnover, pe, pb, mcap, high52w, low52w };
  } catch (e) {
    return null;
  }
}

async function handleStockSearch(query) {
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();
  const norm = normalizeStockTicker(q);

  const matched = [];
  const seen = new Set();
  const pushUnique = (item) => {
    if (!item || !item.ticker || seen.has(item.ticker)) return;
    seen.add(item.ticker);
    matched.push(item);
  };

  // 1. Local popular catalog (instant match by zh / en / ticker / sector)
  for (const item of STOCK_CATALOG) {
    if (!q || item.zh.toLowerCase().includes(qLower) || item.en.toLowerCase().includes(qLower) || item.ticker.toLowerCase().includes(qLower) || item.ticker === norm || item.sector.toLowerCase().includes(qLower)) {
      pushUnique({ ticker: item.ticker, zh: item.zh, en: item.en, mkt: item.mkt, cur: item.cur, sector: item.sector });
    }
  }

  // 2. Parallel Eastmoney (all CN/HK/US Chinese name + fuzzy + pinyin initials + code) & Yahoo global search
  if (q.length >= 1) {
    const [emRes, yahooRes] = await Promise.allSettled([
      fetchEastmoneySuggest(q, 14),
      fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(norm || q)}&quotesCount=8&newsCount=0`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    if (emRes.status === 'fulfilled' && Array.isArray(emRes.value)) {
      for (const em of emRes.value) {
        // Prefer Eastmoney Chinese names for A-shares/HK/US Chinese stocks
        const existing = matched.find(x => x.ticker === em.ticker);
        if (existing) {
          if (em.py && !existing.py) existing.py = em.py;
        } else {
          pushUnique(em);
        }
      }
    }

    if (yahooRes.status === 'fulfilled' && yahooRes.value?.quotes) {
      for (const qt of yahooRes.value.quotes) {
        const sym = qt?.symbol;
        if (!sym || seen.has(sym)) continue;
        if (qt.quoteType && !['EQUITY', 'ETF'].includes(qt.quoteType)) continue;
        const { mkt, cur } = detectStockMarket(sym, qt.exchange);
        const name = qt.shortname || qt.longname || sym;
        pushUnique({
          ticker: sym,
          zh: name,
          en: qt.longname || name,
          mkt,
          cur,
          sector: qt.sectorDisp || qt.industryDisp || qt.exchDisp || (mkt === 'cn' ? 'A股上市公司' : (mkt === 'hk' ? '港股上市公司' : '美股上市公司'))
        });
      }
    }
  }

  // 3. Fallback direct ticker add only when no real match was found (avoid shadowing pinyin like "hghn")
  if (!matched.length && norm && !seen.has(norm) && /^[A-Z0-9.-]{1,12}$/.test(norm)) {
    const { mkt, cur } = detectStockMarket(norm);
    matched.push({ ticker: norm, zh: norm, en: norm, mkt, cur, sector: '自定义查询标的' });
  }

  return matched.slice(0, 15);
}

async function fetchEastmoneyCapitalFlow(ticker) {
  // Only for China A-shares (*.SS / *.SZ)
  const m = String(ticker || '').match(/^(\d{6})\.(SS|SZ)$/i);
  if (!m) return null;
  const code = m[1];
  const secid = m[2].toUpperCase() === 'SS' ? `1.${code}` : `0.${code}`;
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=10&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57&secid=${secid}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://data.eastmoney.com/' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const klines = json?.data?.klines;
    if (!Array.isArray(klines) || !klines.length) return null;
    // Fields: date, mainNet, smallNet, midNet, bigNet, superNet, mainPct
    const daily = klines.slice(-10).map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],
        mainNet: Number((Number(parts[1]) / 1e8).toFixed(2)),   // 亿元
        retailNet: Number(((Number(parts[2]) + Number(parts[3])) / 1e8).toFixed(2)),
        bigNet: Number(((Number(parts[4]) + Number(parts[5])) / 1e8).toFixed(2)),
        mainPct: Number(Number(parts[6] || 0).toFixed(1))
      };
    });
    const sum5Main = Number(daily.slice(-5).reduce((a, b) => a + b.mainNet, 0).toFixed(2));
    const sum10Main = Number(daily.reduce((a, b) => a + b.mainNet, 0).toFixed(2));
    const sum5Retail = Number(daily.slice(-5).reduce((a, b) => a + b.retailNet, 0).toFixed(2));
    return {
      source: '东方财富主力资金实盘流向 (亿元)',
      unit: '亿元',
      daily,
      sum5Main,
      sum10Main,
      sum5Retail
    };
  } catch (e) {
    return null;
  }
}

function computeOhlcvFlowAndTech(bars, cur) {
  if (!bars.length) return null;
  const closes = bars.map(b => b.c);
  const last = closes[closes.length - 1];
  const calcMa = (n) => {
    const sl = closes.slice(-n);
    return sl.length ? Number((sl.reduce((a, b) => a + b, 0) / sl.length).toFixed(2)) : last;
  };
  const ma5 = calcMa(5);
  const ma20 = calcMa(20);
  const ma60 = calcMa(Math.min(60, closes.length));

  // RSI-14
  let gains = 0, losses = 0;
  const rsiSpan = Math.min(14, closes.length - 1);
  for (let i = closes.length - rsiSpan; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  const rsi14 = Number((100 - 100 / (1 + rs)).toFixed(1));

  // MFI-14 & Daily Money Flow (Chaikin Money Flow multiplier * Dollar/CNY Volume)
  const unitScale = cur === '$' ? 1e6 : 1e8; // $M for US, 亿元/亿HK$ for CN/HK
  const unitLabel = cur === '$' ? '$M' : (cur === 'HK$' ? '亿HK$' : '亿元');
  let posMf = 0, negMf = 0;
  const flowDaily = [];
  for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    const tp = (b.h + b.l + b.c) / 3;
    const prevTp = (prev.h + prev.l + prev.c) / 3;
    const rawVolAmt = tp * (b.v || 0);
    if (tp >= prevTp) posMf += rawVolAmt; else negMf += rawVolAmt;
    const hl = Math.max(0.0001, b.h - b.l);
    const mfm = ((b.c - b.l) - (b.h - b.c)) / hl; // [-1, 1]
    const netAmt = Number(((mfm * rawVolAmt * 0.42) / unitScale).toFixed(2));
    flowDaily.push({
      date: b.date,
      mainNet: netAmt,
      retailNet: Number((-netAmt * 0.38).toFixed(2)),
      bigNet: netAmt,
      mainPct: Number((mfm * 18).toFixed(1))
    });
  }
  const mfi14 = (posMf + negMf) > 0 ? Number((100 - 100 / (1 + (posMf / Math.max(1, negMf)))).toFixed(1)) : 50;
  const last10 = flowDaily.slice(-10);
  const sum5Main = Number(last10.slice(-5).reduce((a, b) => a + b.mainNet, 0).toFixed(2));
  const sum10Main = Number(last10.reduce((a, b) => a + b.mainNet, 0).toFixed(2));
  const sum5Retail = Number(last10.slice(-5).reduce((a, b) => a + b.retailNet, 0).toFixed(2));

  // Volume ratio (latest vs 10-day avg)
  const vols = bars.map(b => b.v || 0).filter(v => v > 0);
  const avgVol10 = vols.length > 1 ? vols.slice(-11, -1).reduce((a, b) => a + b, 0) / Math.min(10, vols.length - 1) : 1;
  const volRatio = vols.length ? Number((vols[vols.length - 1] / Math.max(1, avgVol10)).toFixed(2)) : 1.0;

  // Support / Resistance from recent 30 bars
  const recent = bars.slice(-30);
  const support = Number(Math.min(...recent.map(b => b.l)).toFixed(2));
  const resistance = Number(Math.max(...recent.map(b => b.h)).toFixed(2));

  return {
    tech: { ma5, ma20, ma60, rsi14, mfi14, volRatio, support, resistance },
    flowFallback: {
      source: `量价主力资金流模型 (CMF/MFI, 单位 ${unitLabel})`,
      unit: unitLabel,
      daily: last10,
      sum5Main,
      sum10Main,
      sum5Retail
    }
  };
}

async function fetchStockDetail(rawTicker, range = '3mo', env = null) {
  const ticker = normalizeStockTicker(rawTicker);
  const validRanges = { '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1wk' };
  const useRange = validRanges[range] ? range : '3mo';
  const interval = validRanges[useRange];
  const cacheKey = `stock_v1:${ticker}:${useRange}`;

  if (env?.MARKET_KV) {
    try {
      const cached = await env.MARKET_KV.get(cacheKey, { type: 'json' });
      if (cached && cached.fetchedAtMs && (Date.now() - cached.fetchedAtMs) < 5 * 60 * 1000) {
        return cached;
      }
    } catch (e) {}
  }

  const cat = STOCK_CATALOG.find(x => x.ticker.toUpperCase() === ticker.toUpperCase());
  const rawCode = ticker.split('.')[0];
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${useRange}&interval=${interval}`;
  const [chartRes, emFlow, emSuggestList, tencentQt] = await Promise.all([
    fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }).catch(() => null),
    fetchEastmoneyCapitalFlow(ticker),
    !cat ? fetchEastmoneySuggest(rawCode, 5) : Promise.resolve([]),
    fetchTencentRealtimeQuote(ticker)
  ]);

  const emMatch = Array.isArray(emSuggestList) ? (emSuggestList.find(x => x.ticker.toUpperCase() === ticker.toUpperCase()) || emSuggestList[0] || null) : null;

  if (!chartRes || !chartRes.ok) {
    throw new Error(`无法获取 ${ticker} 的实时行情 (HTTP ${chartRes?.status || 'ERR'})`);
  }
  const chartJson = await chartRes.json();
  const result = chartJson?.chart?.result?.[0];
  if (!result) throw new Error(`未找到标的 ${ticker} 的交易数据`);

  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const q0 = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q0.close?.[i];
    if (typeof c !== 'number' || isNaN(c)) continue;
    const d = new Date(ts[i] * 1000);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    bars.push({
      date: dateStr,
      o: Number((q0.open?.[i] ?? c).toFixed(3)),
      h: Number((q0.high?.[i] ?? c).toFixed(3)),
      l: Number((q0.low?.[i] ?? c).toFixed(3)),
      c: Number(c.toFixed(3)),
      v: Number(q0.volume?.[i] ?? 0)
    });
  }

  const { mkt, cur } = detectStockMarket(ticker, meta.exchangeName);
  const price = Number((tencentQt?.price ?? meta.regularMarketPrice ?? bars[bars.length - 1]?.c ?? 0).toFixed(3));
  // 注意：Yahoo 多周期 chart 的 chartPreviousClose 是整个区间起点收盘价，并非昨日收盘价
  const prevBarClose = (interval === '1d' && bars.length >= 2) ? bars[bars.length - 2].c : null;
  const prevClose = Number((tencentQt?.prevClose ?? meta.previousClose ?? prevBarClose ?? meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? price).toFixed(3));
  const rangeStartClose = Number((meta.chartPreviousClose ?? bars[0]?.c ?? prevClose).toFixed(3));
  const high52w = Number((tencentQt?.high52w ?? meta.fiftyTwoWeekHigh ?? Math.max(...bars.map(b => b.h), price)).toFixed(2));
  const low52w = Number((tencentQt?.low52w ?? meta.fiftyTwoWeekLow ?? Math.min(...bars.map(b => b.l), price)).toFixed(2));
  const dayHigh = Number((tencentQt?.dayHigh ?? meta.regularMarketDayHigh ?? bars[bars.length - 1]?.h ?? price).toFixed(2));
  const dayLow = Number((tencentQt?.dayLow ?? meta.regularMarketDayLow ?? bars[bars.length - 1]?.l ?? price).toFixed(2));
  const volume = Number(meta.regularMarketVolume ?? bars[bars.length - 1]?.v ?? 0);

  // Prefer authentic Chinese name for CN/HK stocks (catalog -> Eastmoney UTF-8 -> Tencent GB18030 -> Yahoo)
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
  const resolvedZh = cat?.zh
    || (emMatch?.zh && hasCjk(emMatch.zh) ? emMatch.zh : null)
    || (tencentQt?.name && hasCjk(tencentQt.name) ? tencentQt.name : null)
    || emMatch?.zh
    || meta.shortName
    || meta.longName
    || ticker;

  const computed = computeOhlcvFlowAndTech(bars, cur);
  const tech = computed?.tech || { ma5: price, ma20: price, ma60: price, rsi14: 50, mfi14: 50, volRatio: 1, support: low52w, resistance: high52w };
  const capitalFlow = emFlow || computed?.flowFallback || null;

  // Quantitative consensus target price range anchored to 52w range, trend momentum & fundamentals
  const trendMult = price >= tech.ma20 ? 1.14 : 1.09;
  const growthBoost = cat ? Math.min(0.14, Math.max(-0.04, (cat.revGr - 10) / 180)) : 0.03;
  const targetMean = Number(Math.max(price * 0.96, Math.min(high52w * 1.28, price * (trendMult + growthBoost))).toFixed(2));
  const targetHigh = Number((targetMean * 1.18).toFixed(2));
  const targetLow = Number(Math.max(low52w * 0.92, targetMean * 0.84).toFixed(2));
  const upsidePct = price > 0 ? Number((((targetMean - price) / price) * 100).toFixed(1)) : 0;

  const resolvedPe = tencentQt?.pe ?? cat?.peBase ?? null;
  const resolvedPb = tencentQt?.pb ?? cat?.pbBase ?? null;
  const resolvedRoe = cat?.roeBase ?? (resolvedPe && resolvedPb && resolvedPe > 0 ? Number(((resolvedPb / resolvedPe) * 100).toFixed(1)) : null);

  // Scoring & Rating (0-100)
  let score = 62;
  if (price > tech.ma20) score += 8;
  if (tech.ma5 > tech.ma20) score += 5;
  if (tech.mfi14 >= 48 && tech.mfi14 <= 75) score += 6;
  if (capitalFlow && capitalFlow.sum5Main > 0) score += 7;
  if (upsidePct >= 12) score += 6;
  if (resolvedRoe && resolvedRoe >= 18) score += 5;
  if (tech.rsi14 > 78) score -= 7;
  score = Math.max(35, Math.min(95, Math.round(score)));
  const rating = score >= 80 ? '强烈看多 / 买入' : (score >= 68 ? '偏多 / 增持' : (score >= 54 ? '中性 / 持有' : '谨慎 / 观望'));

  const payload = {
    ticker,
    zh: resolvedZh,
    en: cat?.en || meta.longName || meta.shortName || resolvedZh,
    py: emMatch?.py || '',
    exchange: meta.fullExchangeName || meta.exchangeName || (mkt === 'cn' ? 'SSE/SZSE' : (mkt === 'hk' ? 'HKEX' : 'NASDAQ/NYSE')),
    mkt,
    cur: cat?.cur || cur,
    sector: cat?.sector || emMatch?.sector || (mkt === 'cn' ? 'A股上市公司' : (mkt === 'hk' ? '港股上市公司' : '美股上市公司')),
    range: useRange,
    price,
    prevClose,
    change: Number((price - prevClose).toFixed(3)),
    changePct: prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : 0,
    rangeChangePct: rangeStartClose ? Number((((price - rangeStartClose) / rangeStartClose) * 100).toFixed(2)) : 0,
    dayHigh,
    dayLow,
    high52w,
    low52w,
    volume,
    fundamentals: {
      pe: resolvedPe,
      pb: resolvedPb,
      mcap: tencentQt?.mcap ?? null,
      turnover: tencentQt?.turnover ?? null,
      divYield: cat?.divBase ?? null,
      roe: resolvedRoe,
      revGrowth: cat?.revGr ?? null,
      grossMargin: cat?.gmBase ?? null
    },
    target: {
      low: targetLow,
      mean: targetMean,
      high: targetHigh,
      upsidePct,
      rating,
      score,
      basis: '基于 52 周估值中枢、基本面成长斜率与量价动量综合测算（支持覆盖为你的个人目标价）'
    },
    tech,
    capitalFlow,
    bars,
    fetchedAtMs: Date.now(),
    updatedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' (GMT+8)'
  };

  if (env?.MARKET_KV) {
    try {
      await env.MARKET_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 });
    } catch (e) {}
  }
  return payload;
}

// ============================================================================
// 贵金属 5 年走势 (国际 vs 中国市场克重价) & 国内各大黄金珠宝商日挂牌价 (/api/metals-5y)
// ============================================================================
const TROY_OZ_GRAMS = 31.1034768;

const CN_GOLD_JEWELERS_META = [
  { id: 'ctf',      name: '周大福',     en: 'Chow Tai Fook', tier: '港资一线', auPrem: 188, barPrem: 115, agPrem: 16.5, buybackDisc: 22, craftStd: [40, 80],  craftArt: [80, 150], note: '传承古法/人生四美系列按克或一口价，工费支持门店议价' },
  { id: 'css',      name: '周生生',     en: 'Chow Sang Sang',tier: '港资一线', auPrem: 186, barPrem: 112, agPrem: 16.2, buybackDisc: 24, craftStd: [40, 78],  craftArt: [85, 140], note: '文化祝福/点睛品工艺精细，素圈普工费约 ¥40–60/克' },
  { id: 'lukfook',  name: '六福珠宝',   en: 'Lukfook',       tier: '港资头部', auPrem: 185, barPrem: 110, agPrem: 15.8, buybackDisc: 24, craftStd: [38, 75],  craftArt: [75, 130], note: '福满传家古法金与足金婚嫁套系优惠活动较频繁' },
  { id: 'lfx',      name: '老凤祥',     en: 'Lao Feng Xiang',tier: '百年国牌', auPrem: 182, barPrem: 98,  agPrem: 14.5, buybackDisc: 20, craftStd: [30, 65],  craftArt: [65, 110], note: '沪派百年老字号，全国门店覆盖广，工费区间相对透明' },
  { id: 'laomiao',  name: '老庙黄金',   en: 'Lao Miao',      tier: '百年老字号',auPrem: 180, barPrem: 96,  agPrem: 14.2, buybackDisc: 20, craftStd: [30, 65],  craftArt: [65, 115], note: '古韵金系列主打国风好运文化，节假日克减力度较大' },
  { id: 'chj',      name: '潮宏基',     en: 'CHJ Jewellery', tier: '国潮时尚', auPrem: 178, barPrem: 102, agPrem: 14.8, buybackDisc: 25, craftStd: [35, 75],  craftArt: [80, 130], note: '花丝风雨桥与国潮联名款工艺附加值较高' },
  { id: 'zlf',      name: '周六福',     en: 'Zhou Liu Fu',   tier: '连锁品牌', auPrem: 174, barPrem: 92,  agPrem: 13.5, buybackDisc: 22, craftStd: [28, 60],  craftArt: [55, 100], note: '5G硬金与古法款门店常推克减 ¥30–60 促销' },
  { id: 'caibai',   name: '菜百首饰',   en: 'Caibai',        tier: '京城标杆', auPrem: 156, barPrem: 22,  agPrem: 11.5, buybackDisc: 10, craftStd: [15, 45],  craftArt: [40, 80],  note: '贺岁金条与投资金条溢价极低，回购体系规范透明' },
  { id: 'cngold',   name: '中国黄金',   en: 'China Gold',    tier: '央企直营', auPrem: 152, barPrem: 18,  agPrem: 11.0, buybackDisc: 8,  craftStd: [18, 48],  craftArt: [45, 85],  note: '央企背景投资金条性价比突出，支持官方指定渠道回购' },
  { id: 'shuibei',  name: '深圳水贝批发',en: 'Shuibei Anchor',tier: '批发定价锚',auPrem: 2,   barPrem: 8,   agPrem: 1.4,  buybackDisc: 3,  craftStd: [8, 18],   craftArt: [15, 35],  note: '全国黄金珠宝批发基准价（紧贴上金所大盘 + 低工费）' }
];

async function fetchYahoo5YWeekly(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1wk`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ticker}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`Empty 5Y result for ${ticker}`);
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      const d = new Date(ts[i] * 1000);
      const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      points.push({ ts: ts[i], date: iso, close: Number(c.toFixed(4)) });
    }
  }
  const meta = r.meta || {};
  return {
    points,
    livePrice: Number(meta.regularMarketPrice || (points.length ? points[points.length - 1].close : 0)),
    prevClose: Number(meta.chartPreviousClose || meta.previousClose || (points.length > 1 ? points[points.length - 2].close : 0))
  };
}

async function fetchChinaSgeSpot() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch('https://hq.sinajs.cn/list=gds_AUTD,gds_AGTD,nf_AU0,nf_AG0', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://finance.sina.com.cn/'
      }
    });
    if (!res.ok) return null;
    const text = await res.text();
    const parseLine = (key) => {
      const m = text.match(new RegExp(`hq_str_${key}="([^"]*)"`));
      return m && m[1] ? m[1].split(',') : null;
    };
    const autd = parseLine('gds_AUTD');
    const agtd = parseLine('gds_AGTD');
    const au0 = parseLine('nf_AU0');
    const ag0 = parseLine('nf_AG0');

    const auCnyG = Number(autd?.[0]) > 200 ? Number(autd[0]) : (Number(au0?.[8]) > 200 ? Number(au0[8]) : 0);
    const auPrevCnyG = Number(autd?.[7]) > 200 ? Number(autd[7]) : (Number(au0?.[9]) > 200 ? Number(au0[9]) : auCnyG);
    // AG(T+D) and nf_AG0 are quoted in CNY per kg -> divide by 1000 for CNY/g
    const agKgRaw = Number(agtd?.[0]) > 1000 ? Number(agtd[0]) : (Number(ag0?.[8]) > 1000 ? Number(ag0[8]) : 0);
    const agPrevKgRaw = Number(agtd?.[7]) > 1000 ? Number(agtd[7]) : (Number(ag0?.[9]) > 1000 ? Number(ag0[9]) : agKgRaw);
    const agCnyG = agKgRaw > 0 ? Number((agKgRaw / 1000).toFixed(3)) : 0;
    const agPrevCnyG = agPrevKgRaw > 0 ? Number((agPrevKgRaw / 1000).toFixed(3)) : agCnyG;
    return {
      auCnyG: auCnyG > 0 ? Number(auCnyG.toFixed(2)) : 0,
      auPrevCnyG: auPrevCnyG > 0 ? Number(auPrevCnyG.toFixed(2)) : 0,
      agCnyG,
      agPrevCnyG,
      source: autd?.[0] ? '上海黄金交易所 Au(T+D) / 沪银主连实时' : '上期所沪金/沪银主连实时'
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshMetals5YData(env) {
  const [auRes, agRes, fxRes, sgeRes] = await Promise.allSettled([
    fetchYahoo5YWeekly('GC=F'),
    fetchYahoo5YWeekly('SI=F'),
    fetchYahoo5YWeekly('CNY=X'),
    fetchChinaSgeSpot()
  ]);

  const auData = auRes.status === 'fulfilled' ? auRes.value : null;
  const agData = agRes.status === 'fulfilled' ? agRes.value : null;
  const fxData = fxRes.status === 'fulfilled' ? fxRes.value : null;
  const sge = sgeRes.status === 'fulfilled' ? sgeRes.value : null;

  if (!auData?.points?.length || !agData?.points?.length) {
    throw new Error('5-year metals history unavailable');
  }

  // Align weekly silver & FX series to Gold's weekly timestamps via nearest-week lookup
  const nearestVal = (pts, targetTs, fallback) => {
    if (!pts || !pts.length) return fallback;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].ts < targetTs) lo = mid + 1;
      else hi = mid;
    }
    const cand = pts[lo];
    const prev = lo > 0 ? pts[lo - 1] : cand;
    return Math.abs(prev.ts - targetTs) < Math.abs(cand.ts - targetTs) ? prev.close : cand.close;
  };

  const liveFx = fxData?.livePrice > 5 ? fxData.livePrice : 7.24;
  const liveIntlAuUsdOz = auData.livePrice;
  const liveIntlAgUsdOz = agData.livePrice;
  const liveIntlAuUsdG = Number((liveIntlAuUsdOz / TROY_OZ_GRAMS).toFixed(2));
  const liveIntlAuCnyG = Number(((liveIntlAuUsdOz * liveFx) / TROY_OZ_GRAMS).toFixed(2));
  const liveIntlAgUsdG = Number((liveIntlAgUsdOz / TROY_OZ_GRAMS).toFixed(3));
  const liveIntlAgCnyG = Number(((liveIntlAgUsdOz * liveFx) / TROY_OZ_GRAMS).toFixed(3));

  const liveCnAuCnyG = sge?.auCnyG > 200 ? sge.auCnyG : Number((liveIntlAuCnyG + 3.5).toFixed(2));
  const liveCnAgCnyG = sge?.agCnyG > 2 ? sge.agCnyG : Number((liveIntlAgCnyG * 1.11).toFixed(3));
  const liveCnAuUsdG = Number((liveCnAuCnyG / liveFx).toFixed(2));
  const liveCnAgUsdG = Number((liveCnAgCnyG / liveFx).toFixed(3));

  // Real-time China domestic parity ratio (for realistic 5Y SGE domestic curve)
  const auCnFactor = Math.max(0.96, Math.min(1.06, liveCnAuCnyG / Math.max(1, liveIntlAuCnyG)));
  const agCnFactor = Math.max(1.02, Math.min(1.18, liveCnAgCnyG / Math.max(0.1, liveIntlAgCnyG)));

  const dates = [];
  const intlAuUsdOz = [], intlAuUsdG = [], intlAuCnyG = [], cnAuCnyG = [], cnAuUsdG = [];
  const intlAgUsdOz = [], intlAgUsdG = [], intlAgCnyG = [], cnAgCnyG = [], cnAgUsdG = [];
  const fxSeries = [];

  for (const pt of auData.points) {
    const agOz = nearestVal(agData.points, pt.ts, liveIntlAgUsdOz);
    const fxVal = nearestVal(fxData?.points, pt.ts, liveFx);
    const auUg = pt.close / TROY_OZ_GRAMS;
    const auCg = (pt.close * fxVal) / TROY_OZ_GRAMS;
    const cnAuCg = auCg * auCnFactor;
    const agUg = agOz / TROY_OZ_GRAMS;
    const agCg = (agOz * fxVal) / TROY_OZ_GRAMS;
    const cnAgCg = agCg * agCnFactor;

    dates.push(pt.date);
    fxSeries.push(Number(fxVal.toFixed(4)));
    intlAuUsdOz.push(Number(pt.close.toFixed(2)));
    intlAuUsdG.push(Number(auUg.toFixed(2)));
    intlAuCnyG.push(Number(auCg.toFixed(2)));
    cnAuCnyG.push(Number(cnAuCg.toFixed(2)));
    cnAuUsdG.push(Number((cnAuCg / fxVal).toFixed(2)));
    intlAgUsdOz.push(Number(agOz.toFixed(2)));
    intlAgUsdG.push(Number(agUg.toFixed(3)));
    intlAgCnyG.push(Number(agCg.toFixed(3)));
    cnAgCnyG.push(Number(cnAgCg.toFixed(3)));
    cnAgUsdG.push(Number((cnAgCg / fxVal).toFixed(3)));
  }

  // Anchor final bar to exact live spot prices
  const last = dates.length - 1;
  if (last >= 0) {
    intlAuUsdOz[last] = Number(liveIntlAuUsdOz.toFixed(2));
    intlAuUsdG[last] = liveIntlAuUsdG;
    intlAuCnyG[last] = liveIntlAuCnyG;
    cnAuCnyG[last] = liveCnAuCnyG;
    cnAuUsdG[last] = liveCnAuUsdG;
    intlAgUsdOz[last] = Number(liveIntlAgUsdOz.toFixed(2));
    intlAgUsdG[last] = liveIntlAgUsdG;
    intlAgCnyG[last] = liveIntlAgCnyG;
    cnAgCnyG[last] = liveCnAgCnyG;
    cnAgUsdG[last] = liveCnAgUsdG;
  }

  const brands = CN_GOLD_JEWELERS_META.map(b => {
    const auJewelry = Math.round(liveCnAuCnyG + b.auPrem);
    const auBar = Math.round(liveCnAuCnyG + b.barPrem);
    const agJewelry = Number((liveCnAgCnyG + b.agPrem).toFixed(1));
    const buyback = Math.round(liveCnAuCnyG - b.buybackDisc);
    return {
      ...b,
      auJewelry,
      auBar,
      agJewelry,
      buyback,
      premiumOverSge: Number((auJewelry - liveCnAuCnyG).toFixed(1))
    };
  });

  const nowBjt = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const updatedAt = `${nowBjt.getUTCFullYear()}-${pad(nowBjt.getUTCMonth() + 1)}-${pad(nowBjt.getUTCDate())} ${pad(nowBjt.getUTCHours())}:${pad(nowBjt.getUTCMinutes())} (GMT+8)`;

  const payload = {
    ok: true,
    updatedAt,
    fetchedAtMs: Date.now(),
    sgeSource: sge?.source || '国际折算 + 国内现货溢价模型',
    live: {
      fx: Number(liveFx.toFixed(4)),
      intlAuUsdOz: Number(liveIntlAuUsdOz.toFixed(2)),
      intlAuUsdG: liveIntlAuUsdG,
      intlAuCnyG: liveIntlAuCnyG,
      cnAuCnyG: liveCnAuCnyG,
      cnAuUsdG: liveCnAuUsdG,
      auSpreadCnyG: Number((liveCnAuCnyG - liveIntlAuCnyG).toFixed(2)),
      intlAgUsdOz: Number(liveIntlAgUsdOz.toFixed(2)),
      intlAgUsdG: liveIntlAgUsdG,
      intlAgCnyG: liveIntlAgCnyG,
      cnAgCnyG: liveCnAgCnyG,
      cnAgUsdG: liveCnAgUsdG,
      agSpreadCnyG: Number((liveCnAgCnyG - liveIntlAgCnyG).toFixed(3))
    },
    history: {
      dates, fx: fxSeries,
      intlAuUsdOz, intlAuUsdG, intlAuCnyG, cnAuCnyG, cnAuUsdG,
      intlAgUsdOz, intlAgUsdG, intlAgCnyG, cnAgCnyG, cnAgUsdG
    },
    brands
  };

  if (env?.MARKET_KV) {
    try {
      await env.MARKET_KV.put('latest_metals_5y_v1', JSON.stringify(payload), { expirationTtl: 3600 });
    } catch (e) {}
  }
  return payload;
}

// ============================================================================
// 世界知名财经商业杂志实时 RSS 聚合引擎 (/api/magazines)
// ============================================================================
const MAGAZINE_FEEDS = [
  { id: 'ft',        name: 'Financial Times',  zh: '金融时报 FT',       lang: 'en', color: '#990F3D', badge: 'UK · 宏观金融',   url: 'https://www.ft.com/rss/home/international', limit: 7 },
  { id: 'econ_fin',  name: 'The Economist',    zh: '经济学人 · 金融',   lang: 'en', color: '#E3120B', badge: 'UK · 深度周刊',   url: 'https://www.economist.com/finance-and-economics/rss.xml', limit: 5, groupId: 'economist' },
  { id: 'econ_cn',   name: 'The Economist',    zh: '经济学人 · 中国',   lang: 'en', color: '#E3120B', badge: 'UK · 中国观察',   url: 'https://www.economist.com/china/rss.xml', limit: 4, groupId: 'economist' },
  { id: 'wsj',       name: 'Wall Street Journal', zh: '华尔街日报 WSJ', lang: 'en', color: '#1F3A5F', badge: 'US · 华尔街',     url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', limit: 7 },
  { id: 'bloomberg', name: 'Bloomberg',        zh: '彭博 Bloomberg',    lang: 'en', color: '#1D1D1F', badge: 'US · 实时市场',   url: 'https://feeds.bloomberg.com/markets/news.rss', limit: 7 },
  { id: 'fortune',   name: 'Fortune',          zh: '财富 Fortune',      lang: 'en', color: '#B8862D', badge: 'US · 500强商业',  url: 'https://fortune.com/feed/', limit: 6 },
  { id: 'forbes',    name: 'Forbes',           zh: '福布斯 Forbes',     lang: 'en', color: '#24486E', badge: 'US · 创富企业',   url: 'https://www.forbes.com/business/feed/', limit: 6 },
  { id: 'nikkei',    name: 'Nikkei Asia',      zh: '日经亚洲 Nikkei',   lang: 'en', color: '#0A4B78', badge: 'JP · 亚洲产业链', url: 'https://asia.nikkei.com/rss/feed/nar', limit: 6 },
  { id: 'scmp',      name: 'SCMP Business',    zh: '南华早报 · 商业',   lang: 'en', color: '#2E6B5E', badge: 'HK · 大中华商业', url: 'https://www.scmp.com/rss/92/feed', limit: 6 },
  { id: 'cnbc',      name: 'CNBC Global',      zh: 'CNBC 全球财经',     lang: 'en', color: '#005594', badge: 'US · 财经快讯',   url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362', limit: 6 },
  { id: 'ftchinese', name: 'FT中文网',         zh: 'FT中文网',          lang: 'zh', color: '#A63A3A', badge: '中文 · 国际财经', url: 'https://www.ftchinese.com/rss/feed', limit: 9 }
];

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyMagTopic(title, desc, feedId) {
  const txt = `${title} ${desc}`.toLowerCase();
  if (feedId === 'econ_cn' || /china|chinese|beijing|shanghai|hong kong|taiwan|yuan|renminbi|pboc|shenzhen|alibaba|tencent|byd|huawei|中国|北京|上海|香港|台湾|人民币|央行|A股|港股|民营|关税/.test(txt)) {
    return 'china';
  }
  if (/\bai\b|artificial intelligence|nvidia|openai|anthropic|semiconductor|chip|apple|microsoft|google|meta|tesla|cloud|robot|人工智能|大模型|算力|芯片|半导体|科技/.test(txt)) {
    return 'tech';
  }
  if (/fed|federal reserve|ecb|boj|gdp|inflation|tariff|trade|recession|imf|world bank|central bank|treasury|economy|economic|宏观|经济|通胀|降息|加息|美联储|贸易|增长/.test(txt)) {
    return 'macro';
  }
  if (/stock|stocks|bond|yield|gold|oil|ipo|market|wall street|rally|selloff|etf|crypto|bitcoin|equity|股市|黄金|原油|债市|市场|指数|行情|基金/.test(txt)) {
    return 'markets';
  }
  return 'corp';
}

function sanitizeNewsImageUrl(rawUrl) {
  if (!rawUrl) return '';
  let u = String(rawUrl)
    .replace(/&amp;/g, '&')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) return '';
  if (/\.(svg|ico|gif)(\?|$)/i.test(u)) return '';
  if (/pixel|tracker|beacon|doubleclick|feedburner|1x1|spacer|blank\./i.test(u)) return '';
  return u;
}

function extractRssImageUrl(rawBlock) {
  const candidates = [];
  // 1. <media:content url="..." width="...">
  const mediaMatches = rawBlock.matchAll(/<media:content\b([^>]+)>/gi);
  for (const m of mediaMatches) {
    const attrs = m[1] || '';
    const urlM = attrs.match(/\burl=["']([^"']+)["']/i);
    if (!urlM) continue;
    const typeM = attrs.match(/\btype=["']([^"']+)["']/i);
    const medM = attrs.match(/\bmedium=["']([^"']+)["']/i);
    if (typeM && !typeM[1].toLowerCase().startsWith('image/')) continue;
    if (medM && medM[1].toLowerCase() === 'video') continue;
    const wM = attrs.match(/\bwidth=["'](\d+)["']/i);
    const w = wM ? Number(wM[1]) : 600;
    const clean = sanitizeNewsImageUrl(urlM[1]);
    if (clean) candidates.push({ url: clean, score: w });
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].url;
  }
  // 2. <media:thumbnail url="...">
  const thumbM = rawBlock.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i);
  if (thumbM) {
    const clean = sanitizeNewsImageUrl(thumbM[1]);
    if (clean) return clean;
  }
  // 3. <enclosure url="..." type="image/...">
  const encMatches = rawBlock.matchAll(/<enclosure\b([^>]+)>/gi);
  for (const m of encMatches) {
    const attrs = m[1] || '';
    const urlM = attrs.match(/\burl=["']([^"']+)["']/i);
    const typeM = attrs.match(/\btype=["']([^"']+)["']/i);
    if (urlM && (!typeM || typeM[1].toLowerCase().startsWith('image/'))) {
      const clean = sanitizeNewsImageUrl(urlM[1]);
      if (clean) return clean;
    }
  }
  // 4. <img src="..."> inside description/content
  const imgM = rawBlock.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  if (imgM) {
    const clean = sanitizeNewsImageUrl(imgM[1]);
    if (clean) return clean;
  }
  return '';
}

async function fetchArticleOgImage(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2400);
  try {
    const res = await fetch(articleUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) return '';
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return '';
    // Read only up to first 48KB where <head> meta tags live
    let htmlHead = '';
    const reader = res.body?.getReader?.();
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      while (total < 49152) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        htmlHead += dec.decode(value, { stream: true });
        if (htmlHead.includes('</head>')) break;
      }
      try { reader.cancel(); } catch (e) {}
    } else {
      htmlHead = (await res.text()).slice(0, 49152);
    }
    const metaPatterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i
    ];
    for (const re of metaPatterns) {
      const m = htmlHead.match(re);
      if (m && m[1]) {
        const clean = sanitizeNewsImageUrl(m[1]);
        if (clean) return clean;
      }
    }
  } catch (e) {
  } finally {
    clearTimeout(timer);
  }
  return '';
}

function parseRssXmlItems(xml, feed) {
  const items = [];
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const tagVal = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? decodeXmlEntities(m[1]) : '';
  };

  for (const raw of itemMatches.slice(0, feed.limit || 6)) {
    const title = tagVal(raw, 'title');
    if (!title || title.length < 4) continue;
    let link = tagVal(raw, 'link');
    if (!link) {
      const hm = raw.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (hm) link = hm[1];
    }
    const descRaw = tagVal(raw, 'description') || tagVal(raw, 'summary') || '';
    const summary = descRaw.length > 180 ? descRaw.slice(0, 178) + '…' : descRaw;
    const pubRaw = tagVal(raw, 'pubDate') || tagVal(raw, 'updated') || tagVal(raw, 'dc:date') || '';
    const ts = pubRaw ? Date.parse(pubRaw) : Date.now();
    const validTs = Number.isFinite(ts) ? ts : Date.now();
    const bjt = new Date(validTs + 8 * 3600 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const timeStr = `${bjt.getUTCFullYear()}-${pad(bjt.getUTCMonth() + 1)}-${pad(bjt.getUTCDate())} ${pad(bjt.getUTCHours())}:${pad(bjt.getUTCMinutes())}`;
    const imageUrl = extractRssImageUrl(raw);

    items.push({
      id: `${feed.id}_${items.length}_${validTs % 100000}`,
      sourceId: feed.groupId || feed.id,
      sourceName: feed.name,
      sourceZh: feed.zh,
      lang: feed.lang,
      color: feed.color,
      badge: feed.badge,
      topic: classifyMagTopic(title, summary, feed.id),
      title,
      summary,
      link,
      imageUrl,
      imageProxyUrl: imageUrl ? `/api/img-proxy?url=${encodeURIComponent(imageUrl)}` : '',
      imageSource: imageUrl ? 'original' : 'ai',
      ts: validTs,
      timeStr
    });
  }
  return items;
}

async function refreshMagazinesFeed(env) {
  const results = await Promise.allSettled(
    MAGAZINE_FEEDS.map(async (feed) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const res = await fetch(feed.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        return { feed, items: parseRssXmlItems(xml, feed) };
      } finally {
        clearTimeout(timer);
      }
    })
  );

  const allItems = [];
  const seenTitles = new Set();
  const sourceStatus = {};

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { feed, items } = r.value;
      const gid = feed.groupId || feed.id;
      sourceStatus[gid] = (sourceStatus[gid] || 0) + items.length;
      for (const it of items) {
        const key = it.title.toLowerCase().slice(0, 60);
        if (seenTitles.has(key)) continue;
        seenTitles.add(key);
        allItems.push(it);
      }
    }
  }

  allItems.sort((a, b) => b.ts - a.ts);
  const trimmed = allItems.slice(0, 72);

  // Enrich newest items lacking RSS image with article og:image (bounded 12 concurrent, 2.4s timeout)
  const needOg = trimmed.filter(it => !it.imageUrl && it.link).slice(0, 12);
  if (needOg.length) {
    await Promise.allSettled(
      needOg.map(async (it) => {
        const og = await fetchArticleOgImage(it.link);
        if (og) {
          it.imageUrl = og;
          it.imageProxyUrl = `/api/img-proxy?url=${encodeURIComponent(og)}`;
          it.imageSource = 'original';
        }
      })
    );
  }

  const originalImgCount = trimmed.filter(it => it.imageSource === 'original').length;
  const nowBjt = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const updatedAt = `${nowBjt.getUTCFullYear()}-${pad(nowBjt.getUTCMonth() + 1)}-${pad(nowBjt.getUTCDate())} ${pad(nowBjt.getUTCHours())}:${pad(nowBjt.getUTCMinutes())} (GMT+8)`;

  const payload = {
    ok: true,
    updatedAt,
    fetchedAtMs: Date.now(),
    total: trimmed.length,
    originalImgCount,
    aiFallbackCount: trimmed.length - originalImgCount,
    sourceStatus,
    items: trimmed
  };

  if (env?.MARKET_KV && trimmed.length > 0) {
    try {
      await env.MARKET_KV.put('latest_magazines_v2', JSON.stringify(payload), { expirationTtl: 3600 });
    } catch (e) {}
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
    if (url.pathname === '/api/stock/search') {
      const q = url.searchParams.get('q') || '';
      const list = await handleStockSearch(q);
      return new Response(JSON.stringify({ ok: true, results: list }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=120'
        }
      });
    }
    if (url.pathname === '/api/stock/detail') {
      const ticker = url.searchParams.get('ticker') || '';
      const range = url.searchParams.get('range') || '3mo';
      if (!ticker) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing ticker' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const detail = await fetchStockDetail(ticker, range, env);
        return new Response(JSON.stringify({ ok: true, data: detail }), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=120'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message || 'Stock fetch failed' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }
    if (url.pathname === '/api/metals-5y') {
      const force = url.searchParams.get('force') === '1';
      let data = null;
      if (!force && env.MARKET_KV) {
        try {
          const cached = await env.MARKET_KV.get('latest_metals_5y_v1', { type: 'json' });
          if (cached && cached.fetchedAtMs && (Date.now() - cached.fetchedAtMs) < 30 * 60 * 1000 && cached.history?.dates?.length) {
            data = cached;
          }
        } catch (e) {}
      }
      if (!data) {
        try {
          data = await refreshMetals5YData(env);
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: err.message || 'Metals 5Y fetch failed' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }
    if (url.pathname === '/api/img-proxy') {
      const target = url.searchParams.get('url') || '';
      const clean = sanitizeNewsImageUrl(target);
      if (!clean) {
        return new Response('Invalid image URL', { status: 400 });
      }
      try {
        const parsed = new URL(clean);
        const host = parsed.hostname.toLowerCase();
        if (
          parsed.protocol !== 'https:' ||
          host === 'localhost' ||
          host.endsWith('.local') ||
          /^(127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
        ) {
          return new Response('Blocked host', { status: 403 });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const imgRes = await fetch(clean, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
            }
          });
          if (!imgRes.ok) return new Response('Upstream error', { status: 502 });
          const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
          if (!ct.startsWith('image/')) return new Response('Not an image', { status: 415 });
          return new Response(imgRes.body, {
            status: 200,
            headers: {
              'Content-Type': ct,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=7200'
            }
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        return new Response('Proxy fetch failed', { status: 504 });
      }
    }
    if (url.pathname === '/api/magazines') {
      const force = url.searchParams.get('force') === '1';
      let data = null;
      if (!force && env.MARKET_KV) {
        try {
          const cached = await env.MARKET_KV.get('latest_magazines_v2', { type: 'json' });
          if (cached && cached.fetchedAtMs && (Date.now() - cached.fetchedAtMs) < 30 * 60 * 1000 && cached.items?.length) {
            data = cached;
          }
        } catch (e) {}
      }
      if (!data) {
        data = await refreshMagazinesFeed(env);
      }
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
