/*
 * Secure kit download — handled by the Worker at /api/download
 *
 * After a buyer pays, the site sends them to:
 *   /api/download?kit=kit-dashboard&payment_id=pay_XXXX
 * This function asks Razorpay whether that payment is real, paid in full
 * and for this kit, then sends the buyer to the file.
 *
 * Where the file lives (either works):
 *   - Google Drive (free): set a Worker secret named after the product's
 *     `urlSecret` (e.g. KIT_DASHBOARD_URL) to the Drive share link. The link
 *     is never in public code; buyers only reach it after paying.
 *   - Cloudflare R2: bind a bucket as KITS holding the zip named below.
 *
 * Also needed: Worker secret RAZORPAY_KEY_SECRET (Settings → Variables and
 * Secrets). RAZORPAY_KEY_ID is set in wrangler.jsonc (it is public).
 */

const PRODUCTS = {
  "kit-dashboard": { name: "Motion Dashboard", file: "motion-dashboard.zip", urlSecret: "KIT_DASHBOARD_URL", amount: 90000 }, // paise (₹900)
};

// Discount codes in paise off. Keep in sync with COUPONS in assets/razorpay.js.
const COUPONS = {
  INSTA: 10000, // ₹100 off
};
// Private codes by SHA-256 hash → final amount in paise. Keep in sync with
// PRIVATE_CODES in assets/razorpay.js. Remove after testing.
const PRIVATE_CODES = {
  "179471ae6bf94dbc09e2bc73ffb3952e73c797d9cfc9b1e7a9f99d47a1598146": 100, // test purchase ₹1
};

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const LINK_VALID_DAYS = 30;
const SUPPORT_EMAIL = "hello@pixelift.studio";

export async function handleDownload(request, env) {
  const url = new URL(request.url);
  const kit = url.searchParams.get("kit") || "";
  const paymentId = url.searchParams.get("payment_id") || "";
  const product = PRODUCTS[kit];

  if (!product || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
    return page(400, "Invalid download link", "This link is incomplete. Please use the Download button shown after payment.");
  }
  const fileUrl = driveDirect(env[product.urlSecret]);
  if ((!env.KITS && !fileUrl) || !env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return page(503, "Downloads are being set up", `Your payment is safe. Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) and we'll send your files.`);
  }

  const auth = "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const api = `https://api.razorpay.com/v1/payments/${paymentId}`;

  let payment;
  try {
    const res = await fetch(api, { headers: { Authorization: auth } });
    if (res.status === 400 || res.status === 404) {
      return page(404, "Payment not found", `We couldn't find this payment. Email ${SUPPORT_EMAIL} if you were charged.`);
    }
    if (!res.ok) throw new Error(`Razorpay ${res.status}`);
    payment = await res.json();
  } catch (e) {
    return page(502, "Couldn't verify payment", "Razorpay didn't respond. Please try again in a minute.");
  }

  const notes = payment.notes || {};
  const coupon = String(notes.coupon || "").toUpperCase();
  const priv = coupon ? PRIVATE_CODES[await sha256(coupon)] : undefined;
  const expected = priv !== undefined ? priv : Math.max(100, product.amount - (COUPONS[coupon] || 0));
  if (payment.amount !== expected || payment.currency !== "INR" || notes.product_id !== kit) {
    return page(403, "Payment doesn't match this kit", `Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) and we'll sort it out.`);
  }

  // Payments are usually auto-captured. If this one is only authorised, capture it now.
  if (payment.status === "authorized") {
    const cap = await fetch(`${api}/capture`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: product.amount, currency: "INR" }),
    });
    if (cap.ok) payment = await cap.json();
  }
  if (payment.status !== "captured") {
    return page(402, "Payment not completed", "This payment hasn't gone through yet. If money was deducted, wait a minute and refresh this page.");
  }

  const ageDays = (Date.now() / 1000 - payment.created_at) / 86400;
  if (ageDays > LINK_VALID_DAYS) {
    return page(410, "Download link expired", `Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) for a fresh copy.`);
  }

  if (fileUrl) {
    return new Response(null, { status: 302, headers: { Location: fileUrl, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
  }

  const obj = await env.KITS.get(product.file);
  if (!obj) {
    return page(503, "File temporarily unavailable", `Your payment is confirmed. Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) and we'll send the files right away.`);
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${product.file}"`,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

// Turn a Google Drive share link into a direct-download link; other URLs pass through.
function driveDirect(link) {
  if (!link) return "";
  link = String(link).trim();
  const m = link.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return /^https:\/\//.test(link) ? link : "";
}

function page(status, title, message) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Pixelift Studio</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#07070d;color:#f4f2fb;font:16px/1.55 Inter,system-ui,sans-serif}
.b{max-width:440px;background:#12121c;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:28px}h1{margin:0 0 10px;font-size:22px}p{margin:0 0 20px;color:#9b97ad}
a{display:inline-block;padding:12px 20px;border-radius:99px;font-weight:700;color:#fff;text-decoration:none;background:linear-gradient(90deg,#ff3d7f,#8b5cf6)}</style></head>
<body><div class="b"><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">Back to Pixelift</a></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
