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
  if (!res.ok) throw new Error(`LWA token error: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function spGet(path, token) {
  const res = await fetch(`${SP_API_ENDPOINT}${path}`, {
    headers: {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SP-API ${path} error ${res.status}: ${body}`);
  }
  return res.json();
}

async function getFBAInventory(token) {
  const data = await spGet(
    `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}`,
    token
  );
  return data.payload?.inventorySummaries ?? [];
}

async function getSalesMetrics(asin, days, token) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const interval = `${start.toISOString().split(".")[0]}Z--${end.toISOString().split(".")[0]}Z`;
  const data = await spGet(
    `/sales/v1/orderMetrics?marketplaceIds=${MARKETPLACE_ID}&interval=${encodeURIComponent(interval)}&granularity=Total&asin=${asin}`,
    token
  );
  const metrics = data.payload?.[0];
  return {
    units: metrics?.unitCount ?? 0,
    sales: metrics?.totalSales?.amount ?? 0,
  };
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
    const inventories = await getFBAInventory(token);

    if (!inventories.length) {
      return { statusCode: 200, body: JSON.stringify({ items: [] }) };
    }

    const items = await Promise.all(
      inventories.map(async (inv) => {
        const asin = inv.asin;
        const sku = inv.sellerSku;
        const fnSku = inv.fnSku;
        const productName = inv.productName ?? sku;
        const currentQty =
          (inv.inventoryDetails?.fulfillableQuantity ?? 0) +
          (inv.inventoryDetails?.inboundShippedQuantity ?? 0);

        const [s7, s30, s90] = await Promise.all([
          getSalesMetrics(asin, 7, token),
          getSalesMetrics(asin, 30, token),
          getSalesMetrics(asin, 90, token),
        ]);

        const dailySales30 = s30.units / 30;
        const stockDays = dailySales30 > 0 ? Math.round(currentQty / dailySales30) : 999;

        const leadTimeDays = 14;
        const safetyDays = 7;
        const reorderPoint = Math.round(dailySales30 * (leadTimeDays + safetyDays));

        const trend = s7.units / 7 > dailySales30 * 1.3 ? "rising" : "stable";

        let orderStatus = "OK";
        if (currentQty <= reorderPoint) orderStatus = "発注注意";
        else if (stockDays < 30) orderStatus = "要分析";

        return {
          sku,
          fnSku,
          asin,
          productName,
          currentQty,
          units7: s7.units,
          units30: s30.units,
          units90: s90.units,
          sales30: s30.sales,
          dailySales: parseFloat(dailySales30.toFixed(1)),
          stockDays,
          reorderPoint,
          trend,
          orderStatus,
          group: "C",
        };
      })
    );

    items.sort((a, b) => b.sales30 - a.sales30);
    const classified = calcABC(items);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        items: classified,
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
