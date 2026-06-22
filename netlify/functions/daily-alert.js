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
  if (!data.access_token) throw new Error(`LWA error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function spGet(path, token, retry = 3) {
  for (let i = 0; i < retry; i++) {
    const res = await fetch(`${SP_API_ENDPOINT}${path}`, {
      headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, (i + 1) * 3000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SP-API ${path} error ${res.status}: ${body}`);
    }
    return res.json();
  }
  throw new Error(`Rate limit exceeded after ${retry} retries`);
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
  try {
    const data = await spGet(
      `/sales/v1/orderMetrics?marketplaceIds=${MARKETPLACE_ID}&interval=${encodeURIComponent(interval)}&granularity=Total&asin=${asin}`,
      token
    );
    const m = data.payload?.[0];
    return { units: m?.unitCount ?? 0 };
  } catch {
    return { units: 0 };
  }
}

function buildAlertEmailHTML(alerts, updatedAt) {
  const jstDate = new Date(updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  const rows = alerts
    .map(
      (i) => `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #fee2e2;">
        <strong>${i.productName}</strong><br>
        <span style="font-size:11px;color:#9ca3af;">SKU: ${i.sku}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #fee2e2;text-align:right;color:#dc2626;font-weight:600;">${i.currentQty.toLocaleString()} 個</td>
      <td style="padding:10px 12px;border-bottom:1px solid #fee2e2;text-align:right;">${i.reorderPoint.toLocaleString()} 個</td>
      <td style="padding:10px 12px;border-bottom:1px solid #fee2e2;text-align:right;">${i.stockDays === 999 ? "—" : i.stockDays + " 日"}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #fee2e2;text-align:right;">${i.dailySales} 個/日</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>FBA在庫切れアラート</title></head>
<body style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px;color:#333;">
  <div style="background:#dc2626;color:#fff;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
    <h2 style="margin:0;font-size:18px;">🚨 FBA在庫 発注注意アラート</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">${alerts.length}件の商品が発注点を下回っています</p>
  </div>

  <p style="color:#6b7280;font-size:13px;margin-bottom:16px;">確認日時: ${jstDate} (JST)</p>

  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #fee2e2;">
    <thead>
      <tr style="background:#fef2f2;">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;color:#991b1b;">商品名</th>
        <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #fee2e2;color:#991b1b;">現在庫</th>
        <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #fee2e2;color:#991b1b;">発注点</th>
        <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #fee2e2;color:#991b1b;">在庫日数</th>
        <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #fee2e2;color:#991b1b;">日販</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div style="margin-top:20px;padding:14px 16px;background:#fef9c3;border-radius:8px;font-size:13px;">
    <strong>💡 発注目安:</strong> 発注点 = 日販 × 21日（リードタイム）。在庫日数が30日を切る前に発注を推奨します。
  </div>

  <p style="font-size:12px;color:#aaa;margin-top:24px;">このメールはFBA在庫管理システムから自動送信されています。</p>
</body>
</html>`;
}

export const handler = async () => {
  try {
    const token = await getLWAToken();
    const inventories = await getFBAInventory(token);

    if (!inventories.length) {
      console.log("No inventory items found.");
      return { statusCode: 200, body: "No items" };
    }

    // 並列で販売データ取得（5件ずつバッチ）
    const items = [];
    for (let i = 0; i < inventories.length; i += 5) {
      const batch = inventories.slice(i, i + 5);
      const batchItems = await Promise.all(
        batch.map(async (inv) => {
          const asin = inv.asin;
          const sku = inv.sellerSku;
          const productName = inv.productName ?? sku;
          const currentQty =
            (inv.inventoryDetails?.fulfillableQuantity ?? 0) +
            (inv.inventoryDetails?.inboundShippedQuantity ?? 0);

          const s30 = await getSalesMetrics(asin, 30, token);
          const dailySales = parseFloat((s30.units / 30).toFixed(1));
          const stockDays = dailySales > 0 ? Math.round(currentQty / dailySales) : 999;
          const reorderPoint = Math.round(dailySales * 21);
          const isAlert = currentQty <= reorderPoint;

          return { sku, asin, productName, currentQty, dailySales, stockDays, reorderPoint, isAlert };
        })
      );
      items.push(...batchItems);
      if (i + 5 < inventories.length) await new Promise((r) => setTimeout(r, 500));
    }

    const alerts = items.filter((i) => i.isAlert && i.dailySales > 0);

    if (!alerts.length) {
      console.log("No alerts — all inventory OK.");
      return { statusCode: 200, body: "No alerts" };
    }

    // 在庫日数が少ない順にソート
    alerts.sort((a, b) => a.stockDays - b.stockDays);

    const html = buildAlertEmailHTML(alerts, new Date().toISOString());

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
      from: `"FBA在庫アラート" <${process.env.GMAIL_USER}>`,
      to: process.env.REPORT_EMAIL ?? process.env.GMAIL_USER,
      subject: `🚨【FBA在庫】発注注意 ${alerts.length}件 — ${new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
      html,
    });

    console.log(`Alert sent: ${alerts.length} items`);
    return { statusCode: 200, body: `Alert sent: ${alerts.length} items` };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};
