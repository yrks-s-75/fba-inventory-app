import nodemailer from "nodemailer";

const MARKETPLACE_ID = "A1VC38T7YXB528";
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
  return data.access_token;
}

async function spGet(path, token) {
  const res = await fetch(`${SP_API_ENDPOINT}${path}`, {
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
  });
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
  const m = data.payload?.[0];
  return { units: m?.unitCount ?? 0, sales: m?.totalSales?.amount ?? 0 };
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

function buildEmailHTML(items, updatedAt) {
  const alerts = items.filter((i) => i.orderStatus === "発注注意");
  const checks = items.filter((i) => i.orderStatus === "要分析");

  const tableRows = items
    .map((i) => {
      const groupColor = i.group === "A" ? "#185FA5" : i.group === "B" ? "#3B6D11" : "#854F0B";
      const groupBg = i.group === "A" ? "#E6F1FB" : i.group === "B" ? "#EAF3DE" : "#FAEEDA";
      const statusColor =
        i.orderStatus === "発注注意" ? "#A32D2D" : i.orderStatus === "要分析" ? "#854F0B" : "#3B6D11";
      const statusBg =
        i.orderStatus === "発注注意" ? "#FCEBEB" : i.orderStatus === "要分析" ? "#FAEEDA" : "#EAF3DE";
      const qtyColor = i.currentQty <= i.reorderPoint ? "#A32D2D" : "inherit";
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;"><span style="background:${groupBg};color:${groupColor};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;">${i.group}</span></td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${i.productName}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:${qtyColor};font-weight:${i.currentQty <= i.reorderPoint ? "600" : "400"};">${i.currentQty.toLocaleString()}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.units7}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.units30}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.dailySales}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.stockDays === 999 ? "—" : i.stockDays}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.reorderPoint}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;"><span style="background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:4px;font-size:12px;">${i.orderStatus}</span></td>
      </tr>`;
    })
    .join("");

  const alertSummary =
    alerts.length > 0
      ? `<div style="background:#FCEBEB;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
          <strong style="color:#A32D2D;">🚨 発注注意 ${alerts.length}件:</strong>
          ${alerts.map((i) => `${i.productName}（在庫${i.currentQty}個, 発注点${i.reorderPoint}個）`).join("、")}
        </div>`
      : "";

  const checkSummary =
    checks.length > 0
      ? `<div style="background:#FAEEDA;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
          <strong style="color:#854F0B;">⚠️ 要分析 ${checks.length}件:</strong>
          ${checks.map((i) => `${i.productName}（在庫日数${i.stockDays}日）`).join("、")}
        </div>`
      : "";

  const jstDate = new Date(updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>FBA在庫週次レポート</title></head>
<body style="font-family:sans-serif;max-width:800px;margin:0 auto;padding:24px;color:#333;">
  <h2 style="margin-bottom:4px;">Amazon FBA 在庫週次レポート</h2>
  <p style="color:#888;font-size:13px;margin-bottom:24px;">更新日時: ${jstDate} (JST)</p>

  ${alertSummary}
  ${checkSummary}

  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">G</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">商品名</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">現在庫</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">7日販売</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">30日販売</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">日販</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">在庫日数</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">発注点</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #ddd;">状態</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>

  <p style="font-size:12px;color:#aaa;margin-top:24px;">このメールは自動送信です。</p>
</body>
</html>`;
}

export const handler = async () => {
  try {
    const token = await getLWAToken();
    const inventories = await getFBAInventory(token);
    const updatedAt = new Date().toISOString();

    const items = await Promise.all(
      inventories.map(async (inv) => {
        const asin = inv.asin;
        const sku = inv.sellerSku;
        const productName = inv.productName ?? sku;
        const currentQty =
          (inv.inventoryDetails?.fulfillableQuantity ?? 0) +
          (inv.inventoryDetails?.inboundShippedQuantity ?? 0);

        const [s7, s30] = await Promise.all([
          getSalesMetrics(asin, 7, token),
          getSalesMetrics(asin, 30, token),
        ]);

        const dailySales30 = s30.units / 30;
        const stockDays = dailySales30 > 0 ? Math.round(currentQty / dailySales30) : 999;
        const reorderPoint = Math.round(dailySales30 * 21);

        let orderStatus = "OK";
        if (currentQty <= reorderPoint) orderStatus = "発注注意";
        else if (stockDays < 30) orderStatus = "要分析";

        return {
          sku, asin, productName, currentQty,
          units7: s7.units, units30: s30.units,
          sales30: s30.sales,
          dailySales: parseFloat(dailySales30.toFixed(1)),
          stockDays, reorderPoint, orderStatus, group: "C",
        };
      })
    );

    items.sort((a, b) => b.sales30 - a.sales30);
    const classified = calcABC(items);
    const html = buildEmailHTML(classified, updatedAt);

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"FBA在庫管理" <${process.env.GMAIL_USER}>`,
      to: process.env.REPORT_EMAIL ?? process.env.GMAIL_USER,
      subject: `【FBA在庫】週次レポート ${new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
      html,
    });

    console.log("Weekly report sent.");
    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};
