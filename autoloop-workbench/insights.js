/**
 * 多宝鱼 MCP 洞察数据 — 广告分析 / 广告优化方案 / 店铺优化方案 / 产品优化方案
 *
 * 全部为只读工具；不调用 ads_generate_recommendations（按批计费），
 * 也不调用任何 ads_prepare/execute/apply 写入类工具。
 * 输出经过裁剪，避免把大 payload 发给页面。
 */
'use strict';

const mcp = require('./mcp-client');

async function tryTool(name, args) {
  try {
    return { ok: true, data: await mcp.callTool(name, args) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** 从广告连接信息里选一个启用的广告 profile（优先 US 站）。 */
function pickAdsProfile(conn) {
  const profiles = (conn?.data?.profiles) || [];
  const enabled = profiles.filter((p) => p.enabled);
  return enabled.find((p) => p.marketplace === 'US') || enabled[0] || null;
}

function trimTopics(list, top) {
  return (list || []).slice(0, top).map((t) => ({
    topic: t.topic,
    mentions: t.mentions,
    occurrence_pct: t.occurrence_pct,
    star_rating_impact: t.star_rating_impact,
    parent: t.parent || null,
    snippets: (t.snippets || []).slice(0, 2),
  }));
}

function trimFeedback(fb) {
  if (!fb || typeof fb !== 'object') return null;
  return {
    asin: fb.asin,
    item_name: fb.item_name,
    date_range: fb.date_range || null,
    thin_sample: !!fb.thin_sample,
    note: fb.note || null,
    positive_topics: trimTopics(fb.positive_topics, 4),
    negative_topics: trimTopics(fb.negative_topics, 4),
  };
}

function trimAsinDetail(detail) {
  const d = detail?.data?.data || detail?.data || null;
  if (!d || typeof d !== 'object') return null;
  return {
    asin: d.asin,
    brand: d.brand,
    price: d.price,
    rating: d.rating,
    ratings: d.ratings,
    lqs: d.lqs,
    bsrRank: d.bsrRank,
    bsrLabel: d.bsrLabel,
    subcategories: (d.subcategories || []).slice(0, 2),
    fulfillment: d.fulfillment,
    sellers: d.sellers,
  };
}

function trimCampaigns(camps) {
  const items = (camps?.items || []).slice(0, 12).map((c) => ({
    campaignId: c.campaignId,
    name: c.name,
    state: c.state,
    targetingType: c.targetingType,
    budget: c.budget?.budget ?? null,
    budgetType: c.budget?.budgetType || null,
    startDate: c.startDate || null,
  }));
  return { count: camps?.count ?? items.length, items };
}

function trimSync(sync) {
  return {
    runs: (sync?.runs || []).slice(0, 3).map((r) => ({
      status: r.status,
      trigger: r.trigger,
      started_at: r.started_at,
      finished_at: r.finished_at,
      date_start: r.date_start,
      date_end: r.date_end,
      rows_total: r.rows_total,
      error_message: r.error_message || null,
      families: (r.families || []).map((f) => ({ key: f.key, done: f.done, planned: f.planned, complete: !!f.complete })),
    })),
  };
}

function trimRecommendations(recs) {
  return {
    batch: recs?.batch
      ? {
          created_at: recs.batch.created_at,
          data_health_status: recs.batch.data_health_status,
          data_date_start: recs.batch.data_date_start,
          data_date_end: recs.batch.data_date_end,
          total_count: recs.batch.total_count,
          waste_count: recs.batch.waste_count,
          opportunity_count: recs.batch.opportunity_count,
          watch_count: recs.batch.watch_count,
          summary_text: recs.batch.summary_text,
        }
      : null,
    recommendations: (recs?.recommendations || []).slice(0, 8).map((r) => ({
      id: r.id,
      recommendation_type: r.recommendation_type,
      priority: r.priority,
      target_level: r.target_level,
      target_id: r.target_id,
      summary: r.summary,
      handled_status: r.handled_status,
    })),
  };
}

function trimBalances(bal) {
  const list = (bal?.balances || []).filter((b) => b.currency === 'USD');
  return list.map((b) => ({
    balance_type: b.balance_type,
    amount: b.amount,
    currency: b.currency,
    marketplace: b.marketplace,
    account_type: b.account_type,
    level: b.level,
  }));
}

/* ------------------------- 广告表现（SQL 聚合） ------------------------- */

function aggRow(result) {
  const r = result?.rows?.[0];
  if (!r) return null;
  return {
    impressions: num(r[0]), clicks: num(r[1]), cost: num(r[2]),
    sales: num(r[3]), purchases: num(r[4]),
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function perfSnapshot() {
  const base = "country='US' AND currency='USD' AND ad_product='SPONSORED_PRODUCTS'";
  const calls = [
    tryTool('data_query', {
      sql: `SELECT SUM(impressions), SUM(clicks), SUM(cost), SUM(sales_7d), SUM(purchases_7d) FROM ads_campaign_daily WHERE ${base} AND date >= CURRENT_DATE - INTERVAL '7 DAY'`,
    }, 60000),
    tryTool('data_query', {
      sql: `SELECT SUM(impressions), SUM(clicks), SUM(cost), SUM(sales_7d), SUM(purchases_7d) FROM ads_campaign_daily WHERE ${base} AND date >= CURRENT_DATE - INTERVAL '30 DAY'`,
    }, 60000),
    tryTool('data_query', {
      sql: `SELECT campaign_name, budget, budget_usage_percent, usage_updated_at FROM ads_budget_usage WHERE budget_usage_percent >= 80 ORDER BY budget_usage_percent DESC LIMIT 8`,
    }, 60000),
  ];
  const [p7, p30, budget] = await Promise.all(calls);
  return {
    perf7: p7.ok ? aggRow(p7.data) : null,
    perf7Error: p7.ok ? null : p7.error,
    perf30: p30.ok ? aggRow(p30.data) : null,
    perf30Error: p30.ok ? null : p30.error,
    budgetHot: budget.ok
      ? (budget.data.rows || []).map((row) => ({
          campaign_name: row[0], budget: num(row[1]),
          usage_percent: num(row[2]), updated_at: row[3],
        }))
      : [],
    budgetError: budget.ok ? null : budget.error,
  };
}

/* --------------------------- 补货 / 需求预测 --------------------------- */

function trimForecast(fc) {
  if (!fc || typeof fc !== 'object') return null;
  return {
    pool: fc.pool,
    timeline: fc.timeline || null,
    forecast_by_month: (fc.forecast_by_month || []).slice(0, 12),
    monthly_sales_history: (fc.monthly_sales_history || []).slice(-12),
    styles_missing_season_count: (fc.styles_missing_season || []).length,
  };
}

/* ------------------------- SQP 搜索词漏斗 ------------------------- */

function trimSqp(sqp) {
  const rows = (sqp?.rows || []).slice(0, 3).map((r) => ({
    query: r.query,
    query_volume: r.query_volume,
    query_score: r.query_score,
    market_impressions: r.market?.impressions,
    asin_impressions: r.asin?.impressions,
    asin_clicks: r.asin?.clicks,
    asin_cart_adds: r.asin?.cart_adds,
    asin_purchases: r.asin?.purchases,
    share_impressions: r.share?.impressions,
    share_purchases: r.share?.purchases,
    weakest_stage: r.weakest_stage,
  }));
  return { period: sqp?.period || null, matched_rows: sqp?.matched_rows ?? null, rows };
}

/* ------------------------- 差评主题走势（trends） ------------------------- */

function trimTrendTopics(list) {
  return (list || []).slice(0, 4).map((t) => ({
    topic: t.topic,
    points: (t.points || []).slice(0, 3).map((p) => ({
      start: p.start, end: p.end,
      asin_pct: p.asin_pct, parent_pct: p.parent_pct, category_pct: p.category_pct,
    })),
  }));
}

function trimTrends(tr) {
  if (!tr || typeof tr !== 'object') return null;
  return {
    date_range: tr.date_range || null,
    positive_topics: trimTrendTopics(tr.positive_topics),
    negative_topics: trimTrendTopics(tr.negative_topics),
  };
}

/** 组装整份洞察数据。失败的工具以 ok:false 出现在各分区，不让整体挂掉。 */
async function buildInsights() {
  const parts = {};

  const conn = await tryTool('ads_get_connection_status', {});
  const profile = conn.ok ? pickAdsProfile(conn) : null;
  parts.connection = conn;
  const scope = profile ? profile.id : null;

  if (scope) {
    const [sync, health, settings, campaigns, recs] = await Promise.all([
      tryTool('ads_get_sync_status', { store_scope: scope, limit: 3 }),
      tryTool('ads_get_data_health', { store_scope: scope }),
      tryTool('ads_get_settings', { store_scope: scope }),
      tryTool('ads_list_entities', { store_scope: scope, entity_type: 'sp_campaigns', limit: 12 }),
      tryTool('ads_list_recommendations', { store_scope: scope, limit: 8 }),
    ]);
    parts.sync = { ok: sync.ok, error: sync.error, data: sync.ok ? trimSync(sync.data) : null };
    parts.health = health;
    parts.settings = settings;
    parts.campaigns = {
      ok: campaigns.ok, error: campaigns.error,
      data: campaigns.ok ? trimCampaigns(campaigns.data) : null,
    };
    parts.recommendations = {
      ok: recs.ok, error: recs.error,
      data: recs.ok ? trimRecommendations(recs.data) : null,
    };
  } else {
    const reason = conn.ok
      ? '没有已启用的广告 profile，请先在多宝鱼完成亚马逊广告授权'
      : conn.error;
    for (const key of ['sync', 'health', 'settings', 'campaigns', 'recommendations']) {
      parts[key] = { ok: false, error: reason };
    }
  }

  const balances = await tryTool('finance_get_balances', {});
  parts.balances = {
    ok: balances.ok, error: balances.error,
    data: balances.ok ? trimBalances(balances.data) : null,
  };

  // 广告表现（SQL）+ 预算预警 + 补货预测：互相独立，并行取
  const [perf, forecast] = await Promise.all([
    perfSnapshot(),
    tryTool('restock_get_forecast', { pool: 'US' }, 90000),
  ]);
  parts.performance = {
    ok: !perf.perf7Error || !perf.perf30Error,
    data: {
      perf7: perf.perf7, perf7Error: perf.perf7Error,
      perf30: perf.perf30, perf30Error: perf.perf30Error,
      budgetHot: perf.budgetHot, budgetError: perf.budgetError,
    },
  };
  parts.forecast = {
    ok: forecast.ok, error: forecast.error,
    data: forecast.ok ? trimForecast(forecast.data) : null,
  };

  // 产品优化：取近 24h 热销前 2 的 ASIN，拉买家反馈 + Listing 详情 + SQP 漏斗 + 差评走势
  const products = [];
  const orders = await tryTool('orders_get_recent', { hours: 24 });
  if (orders.ok) {
    const top = (orders.data?.top_skus || []).filter((s) => s.asin).slice(0, 2);
    const rows = await Promise.all(top.map(async (s) => {
      const [fb, detail, sqp, trends] = await Promise.all([
        tryTool('brand_get_customer_feedback', { asin: s.asin }),
        tryTool('market_get_asin', { asin: s.asin }),
        tryTool('brand_get_search_query_performance', { asins: s.asin, period: 'month', limit: 3 }, 150000),
        tryTool('brand_get_customer_feedback', { asin: s.asin, view: 'trends' }, 120000),
      ]);
      return {
        ok: fb.ok || detail.ok,
        data: {
          sku: s.sku,
          asin: s.asin,
          title: s.title,
          units: s.units,
          amount: s.amount,
          currency: s.currency,
          feedback: fb.ok ? trimFeedback(fb.data) : null,
          feedbackError: fb.ok ? null : fb.error,
          detail: detail.ok ? trimAsinDetail(detail.data) : null,
          detailError: detail.ok ? null : detail.error,
          sqp: sqp.ok ? trimSqp(sqp.data) : null,
          sqpError: sqp.ok ? null : sqp.error,
          trends: trends.ok ? trimTrends(trends.data) : null,
          trendsError: trends.ok ? null : trends.error,
        },
      };
    }));
    products.push(...rows);
  }
  parts.products = { ok: products.length > 0, error: orders.ok ? null : orders.error, data: products };

  const keys = Object.keys(parts);
  return {
    ok: keys.every((k) => k === 'products' ? parts[k].ok : parts[k].ok),
    fetchedAt: new Date().toISOString(),
    profile: profile ? { id: profile.id, marketplace: profile.marketplace, last_synced_at: profile.last_synced_at } : null,
    data: parts,
    target: mcp.endpointInfo(),
  };
}

module.exports = { buildInsights };
