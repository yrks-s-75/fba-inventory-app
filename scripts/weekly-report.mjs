import nodemailer from "nodemailer";
import { google } from "googleapis";

const MARKETPLACE_ID = "A1VC38T7YXB528";
const SP_API_ENDPOINT = "https://sellingpartnerapi-fe.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// ─── SP-API ───────────────────────────────────────────────

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
  if (!data.access_token) throw new Error("LWAトークン取得失敗: " + JSON.stringify(data));
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
  const all = data.payload?.inventorySummaries ?? [];
  // アクティブな商品のみ（販売可能・輸送中・予約済みを含む）
  // 全商品を返す（在庫0含む）
  const active = all;
  console.log(`在庫取得: 全${all.length}件 → アクティブ${active.length}件`);
  return active;
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

// ─── ABC分類 ───────────────────────────────────────────────

function calcABC(items) {
  const total = items.reduce((s, i) => s + i.sales30, 0);
  let cum = 0;
  return items.map((item) => {
    cum += item.sales30;
    const pct = total > 0 ? cum / total : 1;
    return { ...item, group: pct <= 0.7 ? "A" : pct <= 0.9 ? "B" : "C" };
  });
}

// ─── Googleスプレッドシート更新 ────────────────────────────

async function updateSheet(items, updatedAt) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) { console.log("GOOGLE_SHEET_ID未設定のためシート更新をスキップ"); return; }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const jstDate = new Date(updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const header = [["更新日時", jstDate]];
  const colHeader = [["グループ", "商品名", "ASIN", "SKU", "現在庫", "7日販売", "30日販売", "90日販売", "日販(30日)", "日販(7日)", "日販(90日)", "在庫日数", "発注点", "発注状態"]];
  const rows = items.map((i) => [
    i.group, i.productName, i.asin, i.sku,
    i.currentQty, i.units7, i.units30, i.units90 ?? 0,
    i.dailySales, i.dailySales7, i.dailySales90,
    i.stockDays === 999 ? "—" : i.stockDays,
    i.reorderPoint, i.orderStatus,
  ]);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: "在庫レポート!A1:B1", values: header },
        { range: "在庫レポート!A2:N2", values: colHeader },
        { range: `在庫レポート!A3:N${3 + rows.length}`, values: rows },
      ],
    },
  });

  // ABCグループ別に色分け
  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheet = sheetMeta.data.sheets.find((s) => s.properties.title === "在庫レポート");
  const sheetGid = sheet?.properties?.sheetId ?? 0;

  const colorMap = {
    A: { red: 0.898, green: 0.945, blue: 0.984 },
    B: { red: 0.918, green: 0.953, blue: 0.871 },
    C: { red: 0.980, green: 0.933, blue: 0.855 },
  };

  const requests = items.map((item, idx) => ({
    repeatCell: {
      range: { sheetId: sheetGid, startRowIndex: idx + 2, endRowIndex: idx + 3, startColumnIndex: 0, endColumnIndex: 14 },
      cell: { userEnteredFormat: { backgroundColor: colorMap[item.group] } },
      fields: "userEnteredFormat.backgroundColor",
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });

  console.log(`スプレッドシート更新完了: ${rows.length}件`);
}

// ─── メール送信 ────────────────────────────────────────────

function buildEmailHTML(items, updatedAt) {
  const alerts = items.filter((i) => i.orderStatus === "発注注意");
  const checks = items.filter((i) => i.orderStatus === "要分析");

  const tableRows = items.map((i) => {
    const groupColor = i.group === "A" ? "#185FA5" : i.group === "B" ? "#3B6D11" : "#854F0B";
    const groupBg   = i.group === "A" ? "#E6F1FB" : i.group === "B" ? "#EAF3DE" : "#FAEEDA";
    const statusColor = i.orderStatus === "発注注意" ? "#A32D2D" : i.orderStatus === "要分析" ? "#854F0B" : "#3B6D11";
    const statusBg    = i.orderStatus === "発注注意" ? "#FCEBEB" : i.orderStatus === "要分析" ? "#FAEEDA" : "#EAF3DE";
    const qtyColor = i.currentQty <= i.reorderPoint ? "#A32D2D" : "inherit";
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee;"><span style="background:${groupBg};color:${groupColor};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;">${i.group}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${i.productName}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:${qtyColor};font-weight:${i.currentQty <= i.reorderPoint ? "600" : "400"};">${i.currentQty.toLocaleString()}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.units7}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.units30}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.units90 ?? "—"}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.dailySales}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.stockDays === 999 ? "—" : i.stockDays}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${i.reorderPoint}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;"><span style="background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:4px;font-size:12px;">${i.orderStatus}</span></td>
    </tr>`;
  }).join("");

  const alertSummary = alerts.length > 0
    ? `<div style="background:#FCEBEB;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
        <strong style="color:#A32D2D;">🚨 発注注意 ${alerts.length}件:</strong>
        ${alerts.map((i) => `${i.productName}（在庫${i.currentQty}個, 発注点${i.reorderPoint}個）`).join("、")}
      </div>` : "";

  const checkSummary = checks.length > 0
    ? `<div style="background:#FAEEDA;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
        <strong style="color:#854F0B;">⚠️ 要分析 ${checks.length}件:</strong>
        ${checks.map((i) => `${i.productName}（在庫日数${i.stockDays}日）`).join("、")}
      </div>` : "";

  const jstDate = new Date(updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>FBA在庫週次レポート</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#333;">
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
        <th style="padding:8px;text-align:right;border-bottom:2px solid #ddd;">90日販売</th>
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

// ─── メイン ────────────────────────────────────────────────

async function main() {
  console.log("FBA在庫レポート開始...");
  const token = await getLWAToken();
  const inventories = await getFBAInventory(token);
  const updatedAt = new Date().toISOString();
  console.log(`在庫取得: ${inventories.length}件`);

  const items = await Promise.all(
    inventories.map(async (inv) => {
      const asin = inv.asin;
      const sku = inv.sellerSku;
      const productName = inv.productName ?? sku;
      const currentQty = inv.totalQuantity ?? 0;

      const [s7, s30, s90] = await Promise.all([
        getSalesMetrics(asin, 7, token),
        getSalesMetrics(asin, 30, token),
        getSalesMetrics(asin, 90, token),
      ]);

      const dailySales30 = s30.units / 30;
      const stockDays = dailySales30 > 0 ? Math.round(currentQty / dailySales30) : 999;
      const reorderPoint = Math.round(dailySales30 * 21);

      let orderStatus = "OK";
      if (currentQty <= reorderPoint) orderStatus = "発注注意";
      else if (stockDays < 30) orderStatus = "要分析";

      return {
        sku, asin, productName, currentQty,
        units7: s7.units, units30: s30.units, units90: s90.units,
        sales30: s30.sales,
        dailySales: parseFloat(dailySales30.toFixed(1)),
        dailySales7: parseFloat((s7.units / 7).toFixed(1)),
        dailySales90: parseFloat((s90.units / 90).toFixed(1)),
        stockDays, reorderPoint, orderStatus, group: "C",
      };
    })
  );

  items.sort((a, b) => b.sales30 - a.sales30);
  const classified = calcABC(items);

  if (classified.length === 0) {
    console.log("在庫データが0件のためテスト送信を実行します");
  }

  // Googleスプレッドシート更新
  await updateSheet(classified, updatedAt);

  // メール送信
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const toEmail = process.env.REPORT_EMAIL || process.env.GMAIL_USER;
  if (!toEmail) throw new Error("REPORT_EMAIL または GMAIL_USER が設定されていません");

  await transporter.sendMail({
    from: `"FBA在庫管理" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: `【FBA在庫】週次レポート ${new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
    html: buildEmailHTML(classified, updatedAt),
  });

  console.log("完了: メール送信・シート更新");
}

main().catch((err) => { console.error(err); process.exit(1); });
