/**
 * US Stocks valuation API — Cloudflare Worker
 *
 * Required Production secrets:
 *   FINNHUB_API_KEY
 *   SEC_USER_AGENT
 *
 * Endpoints:
 *   GET /api/health
 *   GET /api/search?q=...
 *   GET /api/quote?symbol=AMD
 *   GET /api/sec-facts?symbol=AMD
 *   GET /api/revenue?symbol=AMD
 *   GET /api/valuation?symbol=AMD
 *   GET /api/valuations?symbols=AMD,MSFT,NVDA,SPCX,ANT
 */

const ALLOWED_ORIGIN = "https://nitinbramhankar-ui.github.io";

const COMPANIES = {
  AMD: { name: "Advanced Micro Devices", cik: "0000002488", margin: 0.543, multiple: 10 },
  AMZN: {
    name: "Amazon",
    cik: "0001018724",
    margin: 0.30,
    multiple: 8,
    sotp: true,
    segments: {
      AWS: { margin: 0.60, multiple: 15 },
      Retail: { margin: 0.30, multiple: 8 }
    }
  },
  ASML: { name: "ASML", cik: "0000937966", margin: 0.55, multiple: 12 },
  GOOGL: { name: "Alphabet", cik: "0001652044", margin: 0.60, multiple: 12 },
  GOOG: { name: "Alphabet", cik: "0001652044", margin: 0.60, multiple: 12 },
  META: { name: "Meta Platforms", cik: "0001326801", margin: 0.80, multiple: 12 },
  MSFT: { name: "Microsoft", cik: "0000789019", margin: 0.68, multiple: 12 },
  NVDA: { name: "NVIDIA", cik: "0001045810", margin: 0.75, multiple: 12 },
  SPCX: { name: "Space Exploration Technologies Corp.", cik: "0001181412", margin: 0.62, multiple: 10 },
  ANT: { name: "Anthropic, PBC", cik: "0002130357", margin: 0.384, multiple: 12 },
  TSM: { name: "Taiwan Semiconductor", cik: "0001046179", margin: 0.65, multiple: 10 }
};

const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "SalesRevenueNet",
  "Revenues",
  "SalesRevenueGoodsNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax"
];

const COST_TAGS = [
  "CostOfRevenue",
  "CostOfGoodsAndServicesSold",
  "CostOfGoodsSold",
  "CostOfServices"
];

const CASH_TAGS = [
  "CashAndCashEquivalentsAtCarryingValue"
];

const ST_INVESTMENT_TAGS = [
  "ShortTermInvestments",
  "AvailableForSaleSecuritiesCurrent",
  "MarketableSecuritiesCurrent"
];

const CURRENT_DEBT_TAGS = [
  "ShortTermBorrowings",
  "ShortTermDebtCurrent",
  "LongTermDebtCurrent"
];

const LONG_DEBT_TAGS = [
  "LongTermDebtCurrent",
  "LongTermDebtNoncurrent",
  "LongTermDebt"
];

const DILUTED_SHARE_TAGS = [
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "EntityCommonStockSharesOutstanding"
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function respond(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function err(message, status = 400, origin = "") {
  return respond({ ok: false, error: message }, status, origin);
}

function latestUnit(fact) {
  if (!fact || !fact.units) return null;

  const key =
    Object.keys(fact.units).find(k => k === "USD") ||
    Object.keys(fact.units).find(k => k === "shares") ||
    Object.keys(fact.units)[0];

  return key ? fact.units[key] : null;
}

function normalizedFacts(payload) {
  return payload?.facts || payload;
}
function getFactArray(payload, tags) {
  const facts = normalizedFacts(payload);
  const candidates = [];

  for (const tag of tags) {
    const fact = facts?.["us-gaap"]?.[tag];
    const rows = latestUnit(fact);

    if (!rows?.length) continue;

    const quarters = extractQuarterly(rows);

    if (!quarters.length) continue;

    const latest = quarters[quarters.length - 1];

    candidates.push({
      tag,
      rows,
      latestEnd: latest.end,
      quarterCount: quarters.length,
      latestFiled: latest.filed || ""
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) =>
    b.latestEnd.localeCompare(a.latestEnd) ||
    b.quarterCount - a.quarterCount ||
    b.latestFiled.localeCompare(a.latestFiled)
  );

  return candidates[0];
}

function daySpan(start, end) {
  return (
    Date.parse(end + "T00:00:00Z") -
    Date.parse(start + "T00:00:00Z")
  ) / 86400000;
}

function chooseLatestByPeriod(rows) {
  const m = new Map();

  for (const r of rows) {
    if (!r.start || !r.end || !Number.isFinite(r.val)) continue;

    const k = `${r.start}|${r.end}`;
    const old = m.get(k);

    if (!old || (r.filed || "") > (old.filed || "")) {
      m.set(k, r);
    }
  }

  return [...m.values()];
}

function addDays(date, days) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function extractQuarterly(rows) {
  const valid = chooseLatestByPeriod(rows).filter(r =>
    ["10-Q", "10-K", "20-F", "40-F", "8-K", "S-1", "S-1/A", "S-1/A-1"].includes(r.form || "")
  );

  const direct = valid.filter(r => {
    const d = daySpan(r.start, r.end);
    return d >= 70 && d <= 110;
  });

  const ytd = valid.filter(r => {
    const d = daySpan(r.start, r.end);
    return d >= 150 && d <= 310;
  });

  const annual = valid.filter(r => {
    const d = daySpan(r.start, r.end);
    return d >= 330 && d <= 380;
  });

  const out = new Map();

  for (const r of direct) {
    const old = out.get(r.end);

    if (!old || (r.filed || "") > (old.filed || "")) {
      out.set(r.end, { ...r, method: "reported_quarter" });
    }
  }

  // Q1 = six-month YTD less separately reported Q2.
  // Q1 ends the day before Q2 starts.
  for (const y of ytd) {
    const yd = daySpan(y.start, y.end);

    if (yd < 150 || yd > 210) continue;

    const q2 = direct.find(q =>
      q.end === y.end &&
      q.start &&
      q.start > y.start
    );

    if (!q2) continue;

    const q1End = addDays(q2.start, -1);
    const q1Days = daySpan(y.start, q1End);

    if (q1Days >= 70 && q1Days <= 110 && !out.has(q1End)) {
      out.set(q1End, {
        ...y,
        end: q1End,
        val: y.val - q2.val,
        start: y.start,
        method: "derived_ytd_less_reported_q2"
      });
    }
  }

  // Derive Q3 from consecutive YTD facts.
  const byStart = new Map();

  for (const r of ytd) {
    const a = byStart.get(r.start) || [];
    a.push(r);
    byStart.set(r.start, a);
  }

  for (const arr of byStart.values()) {
    arr.sort((a, b) => a.end.localeCompare(b.end));

    let prev = null;

    for (const r of arr) {
      if (prev) {
        const qStart = addDays(prev.end, 1);
        const d = daySpan(qStart, r.end);

        if (d >= 70 && d <= 110 && !out.has(r.end)) {
          out.set(r.end, {
            ...r,
            val: r.val - prev.val,
            start: qStart,
            method: "derived_ytd_difference"
          });
        }
      }

      prev = r;
    }
  }

  // Q4 = annual less latest matching YTD.
  for (const annualFact of annual) {
    const y = ytd
      .filter(x =>
        x.start === annualFact.start &&
        x.end < annualFact.end
      )
      .sort((x, y) => y.end.localeCompare(x.end))[0];

    if (!y) continue;

    const qStart = addDays(y.end, 1);
    const d = daySpan(qStart, annualFact.end);

    if (d >= 70 && d <= 110 && !out.has(annualFact.end)) {
      out.set(annualFact.end, {
        ...annualFact,
        val: annualFact.val - y.val,
        start: qStart,
        method: "derived_annual_less_ytd"
      });
    }
  }

  return [...out.values()]
    .filter(r => r.val > 0)
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(-5);
}

function extractInstant(payload, tags, asOfEnd = null, maxAgeDays = 180) {
  const facts = normalizedFacts(payload);
  const anchor = asOfEnd || new Date().toISOString().slice(0, 10);

  for (const tag of tags) {
    const found = facts?.["us-gaap"]?.[tag];

    if (!found?.units) continue;

    const unit =
      Object.keys(found.units).find(k => k === "USD") ||
      Object.keys(found.units)[0];

    const rows = (found.units[unit] || [])
      .filter(r => r.end && Number.isFinite(r.val))
      .filter(r => {
        const age = daySpan(r.end, anchor);
        return age >= 0 && age <= maxAgeDays;
      })
      .sort((a, b) =>
        b.end.localeCompare(a.end) ||
        (b.filed || "").localeCompare(a.filed || "")
      );

    if (rows.length) {
      const r = rows[0];

      return {
        value: r.val,
        tag,
        unit,
        filed: r.filed,
        end: r.end,
        ageDays: daySpan(r.end, anchor)
      };
    }
  }

  return null;
}

function extractDurationLatest(payload, tags, maxAgeDays = 180) {
  const facts = normalizedFacts(payload);
  const today = new Date().toISOString().slice(0, 10);

  for (const tag of tags) {
    const found = facts?.["us-gaap"]?.[tag];

    if (!found?.units) continue;

    const unit =
      Object.keys(found.units).find(k => k === "shares") ||
      Object.keys(found.units)[0];

    const rows = (found.units[unit] || [])
      .filter(r => r.start && r.end && Number.isFinite(r.val))
      .filter(r => {
        const d = daySpan(r.start, r.end);
        const age = daySpan(r.end, today);
        return d >= 70 && d <= 110 && age >= 0 && age <= maxAgeDays;
      })
      .sort((a, b) =>
        b.end.localeCompare(a.end) ||
        (b.filed || "").localeCompare(a.filed || "")
      );

    if (rows.length) {
      const r = rows[0];

      return {
        value: r.val,
        tag,
        unit,
        filed: r.filed,
        end: r.end,
        ageDays: daySpan(r.end, today)
      };
    }
  }

  return null;
}

async function fetchSecFacts(cik, env) {
  const url =
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        env.SEC_USER_AGENT ||
        "USStocksDashboard/1.0 contact support@example.com",
      "Accept": "application/json"
    },
    cf: {
      cacheTtl: 3600,
      cacheEverything: true
    }
  });

  if (!res.ok) {
    throw new Error(`SEC CompanyFacts returned ${res.status}`);
  }

  return await res.json();
}

async function fetchFinnhub(path, env) {
  if (!env.FINNHUB_API_KEY) {
    throw new Error("Missing FINNHUB_API_KEY secret");
  }

  const url = new URL(`https://finnhub.io/api/v1${path}`);

  const res = await fetch(url, {
    headers: {
      "X-Finnhub-Token": env.FINNHUB_API_KEY
    },
    cf: {
      cacheTtl: 30,
      cacheEverything: true
    }
  });

  if (!res.ok) {
    throw new Error(`Finnhub returned ${res.status}`);
  }

  return await res.json();
}

function weightedGrowth(quarters) {
  if (quarters.length < 5) return null;

  const q = quarters.slice(-5);
  const rates = [];

  for (let i = 1; i < q.length; i++) {
    rates.push(q[i].revenue / q[i - 1].revenue - 1);
  }

  const weights = [0.10, 0.20, 0.30, 0.40];

  const weighted = rates.reduce(
    (s, r, i) => s + r * weights[i],
    0
  );

  const annualisedUncapped = Math.pow(1 + weighted, 4) - 1;

  return {
    sequentialQoqGrowth: rates,
    weights,
    weightedQoqGrowth: weighted,
    annualisedGrowthUncapped: annualisedUncapped,
    annualisedGrowth: Math.min(2, Math.max(-0.95, annualisedUncapped)),
    cappedAt200Percent: annualisedUncapped > 2
  };
}


async function secRequest(url, env, accept = "*/*") {
  const res = await fetch(url, {
    headers: {
      "User-Agent": env.SEC_USER_AGENT,
      "Accept": accept
    },
    cf: {
      cacheTtl: 3600,
      cacheEverything: true
    }
  });

  if (!res.ok) {
    throw new Error(\`SEC request returned \${res.status}: \${url}\`);
  }

  return res;
}

function cleanSecText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseNvidiaSupplementalRevenue(html) {
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];

  for (const table of tables) {
    const tableText = cleanSecText(table);

    if (!/three months ended/i.test(tableText) ||
        !/\brevenue\b/i.test(tableText)) {
      continue;
    }

    const dateMatches = [...tableText.matchAll(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/gi
    )];

    if (!dateMatches.length) continue;

    const end = new Date(dateMatches[0][0]);
    if (!Number.isFinite(end.getTime())) continue;

    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

    for (const row of rows) {
      const rowText = cleanSecText(row);
      if (!/^revenue\b/i.test(rowText) && !/\brevenue\b/i.test(rowText)) {
        continue;
      }
      if (/total\s+revenue/i.test(rowText)) continue;

      const cells = row.match(/<(?:td|th)\b[\s\S]*?<\/(?:td|th)>/gi) || [];
      if (cells.length < 2) continue;

      const values = cells
        .slice(1)
        .map(cell => cleanSecText(cell))
        .map(value => value.replace(/[$,\s]/g, ""))
        .filter(value => /^\(?\d+(?:\.\d+)?\)?$/.test(value))
        .map(value => Number(value.replace(/[()]/g, "")));

      if (!values.length || !Number.isFinite(values[0]) || values[0] <= 0) {
        continue;
      }

      return {
        end: end.toISOString().slice(0, 10),
        revenue: values[0] * 1e6,
        revenueMillions: values[0]
      };
    }
  }

  return null;
}

async function fetchNvidiaSupplementalQuarter(env) {
  if (!env.SEC_USER_AGENT) {
    throw new Error("Missing SEC_USER_AGENT secret");
  }

  const submissionsUrl =
    "https://data.sec.gov/submissions/CIK0001045810.json";
  const submissionsRes = await secRequest(
    submissionsUrl,
    env,
    "application/json"
  );
  const submissions = await submissionsRes.json();
  const recent = submissions?.filings?.recent;

  if (!recent?.form || !recent?.accessionNumber || !recent?.items) {
    throw new Error("SEC submissions response has no recent filing index");
  }

  const candidates = [];

  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i];
    const items = recent.items[i] || "";
    if (form === "8-K" && /2\.02/.test(items)) {
      candidates.push({
        accession: recent.accessionNumber[i],
        filed: recent.filingDate[i],
        reportDate: recent.reportDate?.[i] || null
      });
    }
  }

  candidates.sort((a, b) => (b.filed || "").localeCompare(a.filed || ""));

  for (const filing of candidates.slice(0, 6)) {
    const accessionCompact = filing.accession.replace(/-/g, "");
    const indexUrl =
      \`https://www.sec.gov/Archives/edgar/data/1045810/\${accessionCompact}/index.json\`;

    const indexRes = await secRequest(indexUrl, env, "application/json");
    const index = await indexRes.json();
    const items = index?.directory?.item || [];

    const exhibit = items.find(item =>
      /EX-99\.3/i.test(item.type || "") ||
      /supplemental.*financial/i.test(item.name || "") ||
      /supplemental.*financial/i.test(item.description || "")
    );

    if (!exhibit?.name || !/\.htm(l)?$/i.test(exhibit.name)) continue;

    const exhibitUrl =
      \`https://www.sec.gov/Archives/edgar/data/1045810/\${accessionCompact}/\${exhibit.name}\`;
    const exhibitRes = await secRequest(exhibitUrl, env, "text/html");
    const html = await exhibitRes.text();
    const parsed = parseNvidiaSupplementalRevenue(html);

    if (parsed) {
      return {
        ...parsed,
        filingDate: filing.filed,
        filingUrl: exhibitUrl,
        source: "SEC 8-K Exhibit 99.3"
      };
    }
  }

  throw new Error("Could not locate NVIDIA quarterly revenue in recent SEC 8-K exhibits");
}

async function latestFiveRevenue(facts, symbol, env) {
  const f = getFactArray(facts, REVENUE_TAGS);

  if (!f) {
    return {
      tag: null,
      quarters: [],
      growth: null,
      status: "revenue_unavailable"
    };
  }

  const raw = extractQuarterly(f.rows);
  let quarters = raw.map(r => ({
    start: r.start,
    end: r.end,
    filingDate: r.filed,
    revenue: r.val,
    revenueBillions: r.val / 1e9,
    method: r.method
  }));

  let supplementalSource = null;
  let supplementalError = null;

  // NVIDIA reports its quarterly revenue in furnished 8-K Exhibit 99.3.
  // That exhibit is not consistently represented in CompanyFacts XBRL.
  if (symbol === "NVDA") {
    try {
      const supplemental = await fetchNvidiaSupplementalQuarter(env);
      const latestCompanyFactsQuarter = quarters[quarters.length - 1];

      if (!latestCompanyFactsQuarter ||
          supplemental.end > latestCompanyFactsQuarter.end) {
        const start = latestCompanyFactsQuarter
          ? addDays(latestCompanyFactsQuarter.end, 1)
          : null;

        quarters.push({
          start,
          end: supplemental.end,
          filingDate: supplemental.filingDate,
          revenue: supplemental.revenue,
          revenueBillions: supplemental.revenue / 1e9,
          method: "sec_8k_exhibit_99_3"
        });

        supplementalSource = supplemental.source;
      }
    } catch (e) {
      supplementalError = e.message;
    }
  }

  quarters = quarters
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(-5);

  const latest = quarters[quarters.length - 1];
  const today = new Date().toISOString().slice(0, 10);

  if (!latest || daySpan(latest.end, today) > 180) {
    return {
      tag: f.tag,
      quarters: [],
      growth: null,
      status: "stale_revenue_data",
      latestAvailableQuarter: latest?.end || null,
      supplementalError
    };
  }

  return {
    tag: f.tag,
    quarters,
    growth: weightedGrowth(quarters),
    status: quarters.length === 5 ? "ok" : "insufficient_quarters",
    supplementalSource,
    supplementalError
  };
}
function balanceSheet(facts) {
  const cash = extractInstant(facts, CASH_TAGS, null, 180);
  const asOf = cash?.end || null;

  const investments = extractInstant(
    facts,
    ST_INVESTMENT_TAGS,
    asOf,
    180
  );

  const shortTermBorrowings = extractInstant(
    facts,
    ["ShortTermBorrowings", "ShortTermDebtCurrent"],
    asOf,
    180
  );

  const currentLongTermDebt = extractInstant(
    facts,
    ["LongTermDebtCurrent"],
    asOf,
    180
  );

  const noncurrentLongTermDebt = extractInstant(
    facts,
    ["LongTermDebtNoncurrent"],
    asOf,
    180
  );

  // LongTermDebt is an aggregate fallback:
  // never add it to current debt.
  const aggregateLongTermDebt = noncurrentLongTermDebt
    ? null
    : extractInstant(facts, ["LongTermDebt"], asOf, 180);

  const cashValue = cash?.value || 0;
  const investmentValue = investments?.value || 0;

  const currentDebt =
    (shortTermBorrowings?.value || 0) +
    (currentLongTermDebt?.value || 0);

  const debtValue = aggregateLongTermDebt
    ? aggregateLongTermDebt.value
    : currentDebt + (noncurrentLongTermDebt?.value || 0);

  return {
    asOf,
    cash: cashValue,
    shortTermInvestments: investmentValue,
    debt: debtValue,
    netCash: cashValue + investmentValue - debtValue,
    components: {
      cash,
      investments,
      shortTermBorrowings,
      currentLongTermDebt,
      noncurrentLongTermDebt,
      aggregateLongTermDebt
    },
    note:
      "Components are limited to the latest cash balance-sheet date (maximum 180-day age). Current and noncurrent debt are added only when separately reported; LongTermDebt is treated as an aggregate fallback. Operating lease liabilities are excluded."
  };
}

function shareCount(facts) {
  const diluted = extractDurationLatest(
    facts,
    ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    180
  );

  if (diluted) {
    return {
      ...diluted,
      basis: "quarterly_diluted_weighted_average"
    };
  }

  const common = extractInstant(
    facts,
    ["EntityCommonStockSharesOutstanding"],
    null,
    180
  );

  return common
    ? {
        ...common,
        basis: "latest_common_shares_proxy_not_diluted"
      }
    : null;
}

function calcScenario(
  latestQuarterRevenue,
  growth,
  margin,
  multiple,
  netCash,
  shares
) {
  const rates = [
    growth,
    growth * 0.75,
    growth * 0.5625
  ];

  const revenueY3 =
    latestQuarterRevenue *
    4 *
    rates.reduce((p, g) => p * (1 + g), 1);

  const evY3 = revenueY3 * margin * multiple;
  const equityY3 = evY3 + netCash;

  const fairPriceY3 =
    shares > 0 ? equityY3 / shares : null;

  return {
    annualGrowthRates: rates,
    year3AnnualRevenue: revenueY3,
    year3EnterpriseValue: evY3,
    year3EquityValue: equityY3,
    year3FairSharePrice: fairPriceY3,
    maxEntryPriceToday:
      fairPriceY3 == null
        ? null
        : fairPriceY3 / Math.pow(1.20, 3)
  };
}

function valuationFor(
  symbol,
  company,
  revenueData,
  bs,
  sharesData,
  quote
) {
  if (!revenueData.quarters.length) {
    return {
      ok: false,
      symbol,
      status: "revenue_unavailable",
      message:
        "No usable quarterly revenue periods were found in SEC CompanyFacts.",
      revenueTag: revenueData.tag,
      availableQuarters: 0
    };
  }

  if (!revenueData.growth) {
    return {
      ok: false,
      symbol,
      status: "need_five_quarters",
      availableQuarters: revenueData.quarters.length,
      message:
        `Only ${revenueData.quarters.length} usable quarterly revenue periods were found; five consecutive quarters are required.`,
      revenue: revenueData
    };
  }

  if (company.sotp) {
    return {
      ok: false,
      symbol,
      status: "segment_data_required",
      message:
        "Amazon valuation requires latest AWS and Retail quarterly revenue for the agreed SOTP. This Worker will not substitute consolidated revenue.",
      revenue: revenueData,
      assumptions: company.segments
    };
  }

  const latest =
    revenueData.quarters[revenueData.quarters.length - 1].revenue;

  const g = revenueData.growth.annualisedGrowth;
  const shares = sharesData?.value || null;
  const netCash = bs.netCash;

  const optimistic = calcScenario(
    latest,
    g,
    company.margin,
    company.multiple,
    netCash,
    shares
  );

  const conservativeRates = [
    g,
    g * 0.50,
    g * 0.25
  ];

  const conservativeRevenue =
    latest *
    4 *
    conservativeRates.reduce((p, x) => p * (1 + x), 1);

  const conservativeEV =
    conservativeRevenue * company.margin * company.multiple;

  const conservativeEquity = conservativeEV + netCash;

  const conservativePrice =
    shares ? conservativeEquity / shares : null;

  const conservative = {
    annualGrowthRates: conservativeRates,
    year3AnnualRevenue: conservativeRevenue,
    year3EnterpriseValue: conservativeEV,
    year3EquityValue: conservativeEquity,
    year3FairSharePrice: conservativePrice,
    maxEntryPriceToday:
      conservativePrice == null
        ? null
        : conservativePrice / Math.pow(1.20, 3)
  };

  return {
    ok: true,
    symbol,
    company: company.name,
    currentPrice: quote?.c ?? null,
    currency: quote?.currency || "USD",
    latestQuarter:
      revenueData.quarters[revenueData.quarters.length - 1],
    quarterlyRevenue: revenueData.quarters,
    growth: revenueData.growth,

    assumptions: {
      contributionMargin: company.margin,
      baseEvMultiple: company.multiple,
      netCash: bs.netCash,
      dilutedShares: shares,
      shareCountSource: sharesData?.tag || null,
      shareCountBasis: sharesData?.basis || null,
      balanceSheetAsOf: bs.asOf || null
    },

    balanceSheet: bs,
    shares: sharesData,
    optimistic,
    conservative,

    model: {
      targetCagr: 0.20,
      holdingPeriodYears: 3,
      sharesHeldConstant: true,
      contributionMarginDefinition:
        "Revenue less direct cost to serve; excludes discretionary R&D, S&M, G&A and expansion/capex.",
      netCashDefinition:
        "Cash + liquid short-term investments - interest-bearing debt; operating leases excluded."
    }
  };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin)
    });
  }

  if (request.method !== "GET") {
    return err("Only GET is supported", 405, origin);
  }

  const path = url.pathname;

  try {
    if (path === "/" || path === "/api/health") {
      return respond({
        ok: true,
        service: "us-stocks",
        endpoints: [
          "/api/search?q=...",
          "/api/quote?symbol=AMD",
          "/api/sec-facts?symbol=AMD",
          "/api/revenue?symbol=AMD",
          "/api/valuation?symbol=AMD",
          "/api/valuations?symbols=AMD,MSFT,SPCX,ANT"
        ],
        configuredSecrets: {
          FINNHUB_API_KEY: Boolean(env.FINNHUB_API_KEY),
          SEC_USER_AGENT: Boolean(env.SEC_USER_AGENT)
        }
      }, 200, origin);
    }

    if (path === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();

      if (q.length < 1) {
        return err("Provide q", 400, origin);
      }

      const data = await fetchFinnhub(
        `/search?q=${encodeURIComponent(q)}`,
        env
      );

      return respond({
        ok: true,
        result: (data.result || []).slice(0, 15).map(x => ({
          symbol: x.symbol,
          description: x.description,
          displaySymbol: x.displaySymbol,
          type: x.type
        }))
      }, 200, origin);
    }

    if (path === "/api/quote") {
      const symbol = (url.searchParams.get("symbol") || "")
        .toUpperCase()
        .trim();

      if (!symbol) {
        return err("Provide symbol", 400, origin);
      }

      const data = await fetchFinnhub(
        `/quote?symbol=${encodeURIComponent(symbol)}`,
        env
      );

      return respond({
        ok: true,
        symbol,
        quote: data
      }, 200, origin);
    }

    const symbol = (url.searchParams.get("symbol") || "")
      .toUpperCase()
      .trim();

    if (
      ["/api/sec-facts", "/api/revenue", "/api/valuation"].includes(path) &&
      !symbol
    ) {
      return err("Provide symbol", 400, origin);
    }

    if (
      path === "/api/sec-facts" ||
      path === "/api/revenue" ||
      path === "/api/valuation"
    ) {
      const company = COMPANIES[symbol];

      if (!company) {
        return err(
          `No SEC/valuation configuration for ${symbol}`,
          404,
          origin
        );
      }

      const facts = await fetchSecFacts(company.cik, env);

      if (path === "/api/sec-facts") {
        return respond({
          ok: true,
          symbol,
          cik: company.cik,
          entityName: facts.entityName,
          facts
        }, 200, origin);
      }

      const revenueData = await latestFiveRevenue(facts, symbol, env);

      if (path === "/api/revenue") {
        return respond({
          ok: true,
          symbol,
          company: company.name,
          revenueTag: revenueData.tag,
          quarters: revenueData.quarters,
          growth: revenueData.growth
        }, 200, origin);
      }

      const [quoteResult] = await Promise.allSettled([
        fetchFinnhub(
          `/quote?symbol=${encodeURIComponent(symbol)}`,
          env
        )
      ]);

      const quote =
        quoteResult.status === "fulfilled"
          ? quoteResult.value
          : null;

      const bs = balanceSheet(facts);
      const shares = shareCount(facts);

      const result = valuationFor(
        symbol,
        company,
        revenueData,
        bs,
        shares,
        quote
      );

      return respond(result, result.ok ? 200 : 422, origin);
    }

    if (path === "/api/valuations") {
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 20);

      if (!symbols.length) {
        return err("Provide comma-separated symbols", 400, origin);
      }

      const results = await Promise.all(
        symbols.map(async s => {
          const company = COMPANIES[s];

          if (!company) {
            return {
              ok: false,
              symbol: s,
              status: "not_configured"
            };
          }

          try {
            const facts = await fetchSecFacts(company.cik, env);
            const revenueData = await latestFiveRevenue(facts, s, env);
            const bs = balanceSheet(facts);
            const shares = shareCount(facts);

            let quote = null;

            try {
              quote = await fetchFinnhub(
                `/quote?symbol=${encodeURIComponent(s)}`,
                env
              );
            } catch (_) {}

            return valuationFor(
              s,
              company,
              revenueData,
              bs,
              shares,
              quote
            );
          } catch (e) {
            return {
              ok: false,
              symbol: s,
              status: "fetch_error",
              error: e.message
            };
          }
        })
      );

      return respond({
        ok: true,
        results
      }, 200, origin);
    }

    return err("Unknown endpoint", 404, origin);

  } catch (e) {
    return err(
      e.message || "Unexpected error",
      500,
      origin
    );
  }
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  }
};
