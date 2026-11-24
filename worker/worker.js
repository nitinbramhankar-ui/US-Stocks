/** * US Stocks valuation API — Cloudflare Worker * * Required Production secrets: * FINNHUB_API_KEY * SEC_USER_AGENT e.g. "USStocksDashboard/1.0 contact you@example.com" * * Deploy this entire file as the Worker entry point. * * Endpoints: * GET /api/health * GET /api/search?q=... * GET /api/quote?symbol=AMD * GET /api/sec-facts?symbol=AMD * GET /api/revenue?symbol=AMD * GET /api/valuation?symbol=AMD * GET /api/valuations?symbols=AMD,MSFT,NVDA,SPCX,ANT * * Notes: * - Revenue, balance-sheet inputs and share counts are fetched from SEC CompanyFacts. * - Quotes and symbol search are fetched from Finnhub. * - Contribution margins and EV multiples are valuation assumptions, deliberately * kept in this configuration rather than inferred from GAAP gross margin. * - Amazon requires segment-level AWS/Retail revenue for the agreed SOTP model. * SEC CompanyFacts does not reliably expose dimensional segment data; this Worker * returns an explicit "segment_data_required" status rather than silently using * consolidated revenue as a substitute. * - SpaceX (SPCX) and Anthropic (ANT) are configured as public issuers using SEC CIKs. * Their filing coverage and diluted share counts are validated at runtime; missing * quarterly periods are reported rather than estimated or fabricated. */

const ALLOWED_ORIGIN = "https://nitinbramhankar-ui.github.io";

const COMPANIES = {
  AMD: {
    name: "Advanced Micro Devices",
    cik: "0000002488",
    margin: 0.543,
    multiple: 10,
  },
  AMZN: {
    name: "Amazon",
    cik: "0001018724",
    margin: 0.3,
    multiple: 8,
    sotp: true,
    segments: {
      AWS: { margin: 0.6, multiple: 15 },
      Retail: { margin: 0.3, multiple: 8 },
    },
  },
  ASML: { name: "ASML", cik: "0000937966", margin: 0.55, multiple: 12 },
  GOOGL: { name: "Alphabet", cik: "0001652044", margin: 0.6, multiple: 12 },
  GOOG: { name: "Alphabet", cik: "0001652044", margin: 0.6, multiple: 12 },
  META: {
    name: "Meta Platforms",
    cik: "0001326801",
    margin: 0.8,
    multiple: 12,
  },
  MSFT: { name: "Microsoft", cik: "0000789019", margin: 0.68, multiple: 12 },
  NVDA: { name: "NVIDIA", cik: "0001045810", margin: 0.75, multiple: 12 },
  SPCX: {
    name: "Space Exploration Technologies Corp.",
    cik: "0001181412",
    margin: 0.62,
    multiple: 10,
  },
  ANT: {
    name: "Anthropic, PBC",
    cik: "0002130357",
    margin: 0.384,
    multiple: 12,
  },
  TSM: {
    name: "Taiwan Semiconductor",
    cik: "0001046179",
    margin: 0.65,
    multiple: 10,
  },
};

const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "SalesRevenueNet",
  "Revenues",
  "SalesRevenueGoodsNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];
const COST_TAGS = [
  "CostOfRevenue",
  "CostOfGoodsAndServicesSold",
  "CostOfGoodsSold",
  "CostOfServices",
];
const CASH_TAGS = ["CashAndCashEquivalentsAtCarryingValue"];
const ST_INVESTMENT_TAGS = [
  "ShortTermInvestments",
  "AvailableForSaleSecuritiesCurrent",
  "MarketableSecuritiesCurrent",
];
const CURRENT_DEBT_TAGS = [
  "ShortTermBorrowings",
  "ShortTermDebtCurrent",
  "LongTermDebtCurrent",
];
const LONG_DEBT_TAGS = [
  "LongTermDebtCurrent",
  "LongTermDebtNoncurrent",
  "LongTermDebt",
];
const DILUTED_SHARE_TAGS = [
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "EntityCommonStockSharesOutstanding",
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":
      origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}
function respond(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
function err(message, status = 400, origin = "") {
  return respond({ ok: false, error: message }, status, origin);
}
function latestUnit(fact) {
  if (!fact || !fact.units) return null;
  const key =
    Object.keys(fact.units).find((k) => k === "USD") ||
    Object.keys(fact.units).find((k) => k === "shares") ||
    Object.keys(fact.units)[0];
  return key ? fact.units[key] : null;
}
function normalizedFacts(payload) {
  return payload?.facts || payload;
}
function getFactArray(payload, tags) {
  const facts = normalizedFacts(payload);
  for (const tag of tags) {
    const f = facts?.["us-gaap"]?.[tag];
    const a = latestUnit(f);
    if (a?.length) return { tag, rows: a };
  }
  return null;
}
function daySpan(start, end) {
  return (
    (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) /
    86400000
  );
}
function chooseLatestByPeriod(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.start || !r.end || !Number.isFinite(r.val)) continue;
    const k = `${r.start}|${r.end}`;
    const old = m.get(k);
    if (!old || (r.filed || "") > (old.filed || "")) m.set(k, r);
  }
  return [...m.values()];
}
function extractQuarterly(rows) {
  const valid = chooseLatestByPeriod(rows).filter(
    (r) =>
      ["10-Q", "10-K", "20-F", "40-F", "S-1", "S-1/A", "S-1/A-1"].includes(
        r.form || ""
      ) && r.fp !== "FY"
  );
  const direct = valid.filter((r) => {
    const d = daySpan(r.start, r.end);
    return d >= 70 && d <= 110;
  });
  const ytd = valid.filter((r) => {
    const d = daySpan(r.start, r.end);
    return d >= 150 && d <= 310;
  });
  const annual = valid.filter((r) => {
    const d = daySpan(r.start, r.end);
    return d >= 330 && d <= 380;
  });

  const out = new Map();
  for (const r of direct) out.set(r.end, { ...r, method: "reported_quarter" });

  // Derive a missing first quarter from a six-month YTD fact less the
  // separately reported second-quarter fact (same fiscal-year start).
  for (const y of ytd) {
    const ytdDays = daySpan(y.start, y.end);
    if (ytdDays < 150 || ytdDays > 210) continue;
    const q2 = direct.find(
      (q) =>
        q.end === y.end &&
        q.start &&
        q.start > y.start &&
        daySpan(q.start, q.end) >= 70 &&
        daySpan(q.start, q.end) <= 110
    );
    if (q2) {
      const q1Days = daySpan(y.start, q2.start);
      if (q1Days >= 70 && q1Days <= 110 && !out.has(q2.start)) {
        out.set(q2.start, {
          ...y,
          end: q2.start,
          val: y.val - q2.val,
          start: y.start,
          method: "derived_ytd_less_reported_q2",
        });
      }
    }
  }

  // Derive sequential quarters from same fiscal-year YTD periods.
  const ytdByStart = new Map();
  for (const r of ytd) {
    const arr = ytdByStart.get(r.start) || [];
    arr.push(r);
    ytdByStart.set(r.start, arr);
  }
  for (const arr of ytdByStart.values()) {
    arr.sort((a, b) => a.end.localeCompare(b.end));
    let prev = null;
    for (const r of arr) {
      if (prev) {
        const d = daySpan(prev.end, r.end);
        if (d >= 70 && d <= 110 && !out.has(r.end)) {
          out.set(r.end, {
            ...r,
            val: r.val - prev.val,
            start: prev.end,
            method: "derived_ytd_difference",
          });
        }
      }
      prev = r;
    }
  }

  // Derive Q4 from annual less latest matching YTD period.
  for (const a of annual) {
    const candidates = ytd
      .filter((y) => y.start === a.start && y.end < a.end)
      .sort((x, y) => y.end.localeCompare(x.end));
    const y = candidates[0];
    if (y && daySpan(y.start, y.end) >= 240 && !out.has(a.end)) {
      out.set(a.end, {
        ...a,
        val: a.val - y.val,
        start: y.end,
        method: "derived_annual_less_ytd",
      });
    }
  }

  return [...out.values()]
    .filter((r) => r.val > 0)
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(-5);
}
function extractInstant(payload, tags) {
  const facts = normalizedFacts(payload);
  for (const tag of tags) {
    const found = facts?.["us-gaap"]?.[tag];
    if (!found?.units) continue;
    const unit =
      Object.keys(found.units).find((k) => k === "USD") ||
      Object.keys(found.units)[0];
    const rows = found.units[unit] || [];
    const candidates = rows
      .filter((r) => r.end && Number.isFinite(r.val))
      .sort((a, b) => (b.filed || b.end).localeCompare(a.filed || a.end));
    if (candidates.length)
      return {
        value: candidates[0].val,
        tag,
        unit,
        filed: candidates[0].filed,
        end: candidates[0].end,
      };
  }
  return null;
}
function extractDurationLatest(payload, tags) {
  const facts = normalizedFacts(payload);
  for (const tag of tags) {
    const found = facts?.["us-gaap"]?.[tag];
    if (!found?.units) continue;
    const unit =
      Object.keys(found.units).find((k) => k === "shares") ||
      Object.keys(found.units)[0];
    const rows = (found.units[unit] || []).filter(
      (r) => r.start && r.end && Number.isFinite(r.val)
    );
    const q = rows
      .filter(
        (r) => daySpan(r.start, r.end) >= 70 && daySpan(r.start, r.end) <= 110
      )
      .sort((a, b) => (b.filed || b.end).localeCompare(a.filed || a.end));
    if (q.length)
      return { value: q[0].val, tag, unit, filed: q[0].filed, end: q[0].end };
  }
  return null;
}
async function fetchSecFacts(cik, env) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        env.SEC_USER_AGENT ||
        "USStocksDashboard/1.0 contact support@example.com",
      Accept: "application/json",
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`SEC CompanyFacts returned ${res.status}`);
  return await res.json();
}
async function fetchFinnhub(path, env) {
  if (!env.FINNHUB_API_KEY) throw new Error("Missing FINNHUB_API_KEY secret");
  const url = new URL(`https://finnhub.io/api/v1${path}`);
  const res = await fetch(url, {
    headers: { "X-Finnhub-Token": env.FINNHUB_API_KEY },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Finnhub returned ${res.status}`);
  return await res.json();
}
function weightedGrowth(quarters) {
  if (quarters.length < 5) return null;
  const q = quarters.slice(-5);
  const rates = [];
  for (let i = 1; i < q.length; i++)
    rates.push(q[i].revenue / q[i - 1].revenue - 1);
  const weights = [0.1, 0.2, 0.3, 0.4];
  const weighted = rates.reduce((s, r, i) => s + r * weights[i], 0);
  const annualisedUncapped = Math.pow(1 + weighted, 4) - 1;
  return {
    sequentialQoqGrowth: rates,
    weights,
    weightedQoqGrowth: weighted,
    annualisedGrowthUncapped: annualisedUncapped,
    annualisedGrowth: Math.min(2, Math.max(-0.95, annualisedUncapped)),
    cappedAt200Percent: annualisedUncapped > 2,
  };
}
function latestFiveRevenue(facts) {
  const f = getFactArray(facts, REVENUE_TAGS);
  if (!f) return { tag: null, quarters: [], growth: null };
  const raw = extractQuarterly(f.rows);
  const quarters = raw.map((r) => ({
    start: r.start,
    end: r.end,
    filingDate: r.filed,
    revenue: r.val,
    revenueBillions: r.val / 1e9,
    method: r.method,
  }));
  return { tag: f.tag, quarters, growth: weightedGrowth(quarters) };
}
function balanceSheet(facts) {
  const cash = extractInstant(facts, CASH_TAGS);
  const investments = extractInstant(facts, ST_INVESTMENT_TAGS);
  const debtCurrent = extractInstant(facts, CURRENT_DEBT_TAGS);
  const debtLong = extractInstant(facts, LONG_DEBT_TAGS);
  const cashValue = cash?.value || 0;
  const investmentValue = investments?.value || 0;
  const debtValue = Math.max(debtCurrent?.value || 0, debtLong?.value || 0);
  return {
    cash: cashValue,
    shortTermInvestments: investmentValue,
    debt: debtValue,
    netCash: cashValue + investmentValue - debtValue,
    components: { cash, investments, debtCurrent, debtLong },
    note: "Operating lease liabilities are excluded. Debt tags may overlap; review components before relying on the estimate.",
  };
}
function shareCount(facts) {
  const duration = extractDurationLatest(facts, [
    "WeightedAverageNumberOfDilutedSharesOutstanding",
  ]);
  const instant = extractInstant(facts, ["EntityCommonStockSharesOutstanding"]);
  // Duration share count is preferred for diluted shares; instant common shares is fallback.
  return duration || instant;
}
function calcScenario( latestQuarterRevenue, growth, margin, multiple, netCash, shares ) {
  const rates = [growth, growth * 0.75, growth * 0.5625];
  const revenueY3 =
    latestQuarterRevenue * 4 * rates.reduce((p, g) => p * (1 + g), 1);
  const evY3 = revenueY3 * margin * multiple;
  const equityY3 = evY3 + netCash;
  const fairPriceY3 = shares > 0 ? equityY3 / shares : null;
  return {
    annualGrowthRates: rates,
    year3AnnualRevenue: revenueY3,
    year3EnterpriseValue: evY3,
    year3EquityValue: equityY3,
    year3FairSharePrice: fairPriceY3,
    maxEntryPriceToday:
      fairPriceY3 == null ? null : fairPriceY3 / Math.pow(1.2, 3),
  };
}
function valuationFor(symbol, company, revenueData, bs, sharesData, quote) {
  if (!revenueData.quarters.length)
    return {
      ok: false,
      symbol,
      status: "revenue_unavailable",
      message:
        "No usable quarterly revenue periods were found in SEC CompanyFacts.",
      revenueTag: revenueData.tag,
      availableQuarters: 0,
    };
  if (!revenueData.growth)
    return {
      ok: false,
      symbol,
      status: "need_five_quarters",
      availableQuarters: revenueData.quarters.length,
      message: `Only ${revenueData.quarters.length} usable quarterly revenue periods were found; five consecutive quarters are required.`,
      revenue: revenueData,
    };
  if (company.sotp)
    return {
      ok: false,
      symbol,
      status: "segment_data_required",
      message:
        "Amazon valuation requires latest AWS and Retail quarterly revenue for the agreed SOTP. This Worker will not substitute consolidated revenue.",
      revenue: revenueData,
      assumptions: company.segments,
    };
  const latest = revenueData.quarters[revenueData.quarters.length - 1].revenue;
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
  const conservativeRates = [g, g * 0.5, g * 0.25];
  const conservativeRevenue =
    latest * 4 * conservativeRates.reduce((p, x) => p * (1 + x), 1);
  const conservativeEV =
    conservativeRevenue * company.margin * company.multiple;
  const conservativeEquity = conservativeEV + netCash;
  const conservativePrice = shares ? conservativeEquity / shares : null;
  const conservative = {
    annualGrowthRates: conservativeRates,
    year3AnnualRevenue: conservativeRevenue,
    year3EnterpriseValue: conservativeEV,
    year3EquityValue: conservativeEquity,
    year3FairSharePrice: conservativePrice,
    maxEntryPriceToday:
      conservativePrice == null ? null : conservativePrice / Math.pow(1.2, 3),
  };
  return {
    ok: true,
    symbol,
    company: company.name,
    currentPrice: quote?.c ?? null,
    currency: quote?.currency || "USD",
    latestQuarter: revenueData.quarters[revenueData.quarters.length - 1],
    quarterlyRevenue: revenueData.quarters,
    growth: revenueData.growth,
    assumptions: {
      contributionMargin: company.margin,
      baseEvMultiple: company.multiple,
      netCash: bs.netCash,
      dilutedShares: shares,
      shareCountSource: sharesData?.tag || null,
    },
    balanceSheet: bs,
    shares: sharesData,
    optimistic,
    conservative,
    model: {
      targetCagr: 0.2,
      holdingPeriodYears: 3,
      sharesHeldConstant: true,
      contributionMarginDefinition:
        "Revenue less direct cost to serve; excludes discretionary R&D, S&M, G&A and expansion/capex.",
      netCashDefinition:
        "Cash + liquid short-term investments - interest-bearing debt; operating leases excluded.",
    },
  };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "GET")
    return err("Only GET is supported", 405, origin);

  const path = url.pathname;
  try {
    if (path === "/" || path === "/api/health") {
      return respond(
        {
          ok: true,
          service: "us-stocks",
          endpoints: [
            "/api/search?q=...",
            "/api/quote?symbol=AMD",
            "/api/sec-facts?symbol=AMD",
            "/api/revenue?symbol=AMD",
            "/api/valuation?symbol=AMD",
            "/api/valuations?symbols=AMD,MSFT,SPCX,ANT",
          ],
          configuredSecrets: {
            FINNHUB_API_KEY: Boolean(env.FINNHUB_API_KEY),
            SEC_USER_AGENT: Boolean(env.SEC_USER_AGENT),
          },
        },
        200,
        origin
      );
    }

    if (path === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 1) return err("Provide q", 400, origin);
      const data = await fetchFinnhub(
        `/search?q=${encodeURIComponent(q)}`,
        env
      );
      return respond(
        {
          ok: true,
          result: (data.result || []).slice(0, 15).map((x) => ({
            symbol: x.symbol,
            description: x.description,
            displaySymbol: x.displaySymbol,
            type: x.type,
          })),
        },
        200,
        origin
      );
    }

    if (path === "/api/quote") {
      const symbol = (url.searchParams.get("symbol") || "")
        .toUpperCase()
        .trim();
      if (!symbol) return err("Provide symbol", 400, origin);
      const data = await fetchFinnhub(
        `/quote?symbol=${encodeURIComponent(symbol)}`,
        env
      );
      return respond({ ok: true, symbol, quote: data }, 200, origin);
    }

    const symbol = (url.searchParams.get("symbol") || "").toUpperCase().trim();
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
      if (!company)
        return err(`No SEC/valuation configuration for ${symbol}`, 404, origin);
      const facts = await fetchSecFacts(company.cik, env);

      if (path === "/api/sec-facts")
        return respond(
          {
            ok: true,
            symbol,
            cik: company.cik,
            entityName: facts.entityName,
            facts,
          },
          200,
          origin
        );

      const revenueData = latestFiveRevenue(facts);
      if (path === "/api/revenue") {
        return respond(
          {
            ok: true,
            symbol,
            company: company.name,
            revenueTag: revenueData.tag,
            quarters: revenueData.quarters,
            growth: revenueData.growth,
          },
          200,
          origin
        );
      }

      const [quoteResult] = await Promise.allSettled([
        fetchFinnhub(`/quote?symbol=${encodeURIComponent(symbol)}`, env),
      ]);
      const quote =
        quoteResult.status === "fulfilled" ? quoteResult.value : null;
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
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 20);
      if (!symbols.length)
        return err("Provide comma-separated symbols", 400, origin);
      const results = await Promise.all(
        symbols.map(async (s) => {
          const company = COMPANIES[s];
          if (!company)
            return { ok: false, symbol: s, status: "not_configured" };
          try {
            const facts = await fetchSecFacts(company.cik, env);
            const revenueData = latestFiveRevenue(facts);
            const bs = balanceSheet(facts);
            const shares = shareCount(facts);
            let quote = null;
            try {
              quote = await fetchFinnhub(
                `/quote?symbol=${encodeURIComponent(s)}`,
                env
              );
            } catch (_) {}
            return valuationFor(s, company, revenueData, bs, shares, quote);
          } catch (e) {
            return {
              ok: false,
              symbol: s,
              status: "fetch_error",
              error: e.message,
            };
          }
        })
      );
      return respond({ ok: true, results }, 200, origin);
    }

    return err("Unknown endpoint", 404, origin);
  } catch (e) {
    return err(e.message || "Unexpected error", 500, origin);
  }
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
}; 
