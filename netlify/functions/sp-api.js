const MARKETPLACE_ID = "A1VC38T7YXB528"; // Amazon.co.jp
const SP_API_ENDPOINT = "https://sellingpartnerapi-fe.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

async function getLWAToken() {
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`LWA token error: ${res.status} body=${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function spGet(path, token) {
  const res = await fetch(`${SP_API_ENDPOINT}${path}`, {
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SP-API ${path} error ${res.status}: ${body}`);
  }
  return res.json();
}

async function spPost(path, token, body) {
  const res = await fetch(`${SP_API_ENDPOINT}${path}`, {
    method: "POST",
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SP-API POST ${path} error ${res.status}: ${text}`);
  }
  return res.json();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pLimit(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
    if (i + concurrency < tasks.length) await sleep(500);
  }
  return results;
}

async function getOrdersByDays(days, token) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const params = new URLSearchParams({
    MarketplaceIds: MARKETPLACE_ID,
    CreatedAfter: since.toISOString(),
    OrderStatuses: "Shipped,Unshipped,PartiallyShipped",
  });

  let orders = [];
  let nextToken = null;
  let page = 0;
  do {
    const url = nextToken
      ? `/orders/v0/orders?NextToken=${encodeURIComponent(nextToken)}`
      : `/orders/v0/orders?${params}`;
    const data = await spGet(url, token);
    orders = orders.concat(data.payload?.Orders ?? []);
    nextToken = data.payload?.NextToken ?? null;
    page++;
    if (nextToken) await sleep(300);
  } while (nextToken && page < 5);
  return orders;
}

async function getSalesFromOrders(token) {
  const orders90 = await getOrdersByDays(90, token);
  console.log(`Orders fetched: ${orders90.length}`);

  const skuSales = {};
  const skuInfo = {};

  const tasks = orders90.map((order) => async () => {
    try {
      const itemData = await spGet(`/orders/v0/orders/${order.AmazonOrderId}/orderItems`, token);
      const items = itemData.payload?.OrderItems ?? [];
      const orderDate = new Date(order.PurchaseDate);
      const daysAgo = (Date.now() - orderDate.getTime()) / 86400000;

      for (const item of items) {
        const sku = item.SellerSKU;
        if (!sku) continue;
        if (!skuSales[sku]) {
          skuSales[sku] = { units7: 0, units30: 0, units90: 0, sales30: 0 };
        }
        if (!skuInfo[sku]) {
          skuInfo[sku] = { asin: item.ASIN, productName: item.Title ?? sku };
        }
        const qty = parseInt(item.QuantityOrdered) || 0;
        const amount = parseFloat(item.ItemPrice?.Amount ?? "0") * qty;
        skuSales[sku].units90 += qty;
        if (daysAgo <= 30) { skuSales[sku].units30 += qty; skuSales[sku].sales30 += amount; }
        if (daysAgo <= 7) skuSales[sku].units7 += qty;
      }
    } catch (e) {
      console.warn(`Skip order ${order.AmazonOrderId}: ${e.message}`);
    }
  });

  await pLimit(tasks, 5);
  return { skuSales, skuInfo };
}

// FBA在庫をReports API経由で取得（未使用・保留）
async function getFBAInventoryViaReport(token) {
  // レポートリクエスト作成
  const created = await spPost("/reports/2021-06-30/reports", token, {
    reportType: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
    marketplaceIds: [MARKETPLACE_ID],
  });
  const reportId = created.reportId;
  console.log("Report requested:", reportId);

  // 完成するまでポーリング（最大25秒）
  let report;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    report = await spGet(`/reports/2021-06-30/reports/${reportId}`, token);
    console.log("Report status:", report.processingStatus);
    if (report.processingStatus === "DONE") break;
    if (report.processingStatus === "FATAL" || report.processingStatus === "CANCELLED") {
      throw new Error(`Report failed: ${report.processingStatus}`);
    }
  }

  if (report.processingStatus !== "DONE") {
    throw new Error(`Report timed out with status: ${report.processingStatus}`);
  }

  // ドキュメントURL取得
  const doc = await spGet(`/reports/2021-06-30/documents/${report.reportDocumentId}`, token);

  // レポートダウンロード
  const csvRes = await fetch(doc.url);
  const csvText = await csvRes.text();
  return parseFBAInventoryTSV(csvText);
}

function parseFBAInventoryTSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());

  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const row = {};
    headers.forEach((h, i) => (row[h] = cols[i]?.trim() ?? ""));
    return {
      sku: row["seller-sku"] || row["sku"] || "",
      asin: row["asin"] || "",
      fnSku: row["fnsku"] || "",
      productName: row["product-name"] || row["product name"] || "",
      currentQty: parseInt(row["afn-fulfillable-quantity"] || row["your-fulfillable-quantity"] || "0") || 0,
    };
  }).filter((item) => item.sku && item.asin);
}

async function getSalesMetrics(asin, days, token) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const interval = `${start.toISOString().split(".")[0]}Z--${end.toISOString().split(".")[0]}Z`;
  try {
    const data = await spGet(
      `/sales/v1/orderMetrics?marketplaceIds=${MARKETPLACE_ID}&interval=${encodeURIComponent(interval)}&granularity=Total&asin=${asin}`,
      token
    );
    const metrics = data.payload?.[0];
    return { units: metrics?.unitCount ?? 0, sales: metrics?.totalSales?.amount ?? 0 };
  } catch {
    return { units: 0, sales: 0 };
  }
}

function calcABC(items) {
  const total = items.reduce((s, i) => s + i.sales30, 0);
  let cum = 0;
  return items.map((item) => {
    cum += item.sales30;
    const pct = total > 0 ? cum / total : 1;
    return { ...item, group: pct <= 0.7 ? "A" : pct <= 0.9 ? "B" : "C" };
  });
}

export const handler = async () => {
  try {
    const token = await getLWAToken();
    const { skuSales, skuInfo } = await getSalesFromOrders(token);

    const skus = Object.keys(skuSales);
    if (!skus.length) {
      return { statusCode: 200, body: JSON.stringify({ items: [] }) };
    }

    const items = skus.map((sku) => {
      const s = skuSales[sku];
      const info = skuInfo[sku] ?? { asin: "", productName: sku };
      const dailySales30 = s.units30 / 30;
      // 現在庫はSP-API未取得のため0（ダッシュボードで手入力可能）
      const currentQty = 0;
      const stockDays = 999;
      const reorderPoint = Math.round(dailySales30 * 21);
      const trend = s.units7 / 7 > dailySales30 * 1.3 ? "rising" : "stable";

      return {
        sku,
        asin: info.asin,
        productName: info.productName,
        currentQty,
        units7: s.units7,
        units30: s.units30,
        units90: s.units90,
        sales30: s.sales30,
        dailySales: parseFloat(dailySales30.toFixed(1)),
        stockDays,
        reorderPoint,
        trend,
        orderStatus: "要確認",
        group: "C",
      };
    });

    items.sort((a, b) => b.sales30 - a.sales30);
    const classified = calcABC(items);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: new Date().toISOString(), items: classified }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
