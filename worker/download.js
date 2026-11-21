/*
 * Pixelift Studio — paid kit delivery (Cloudflare Worker)
 *
 *   GET  /api/download?kit=kit-dashboard&payment_id=pay_XXXX
 *        Checks the payment with Razorpay, then streams the zip from this
 *        domain (the Google Drive link is never shown to the buyer).
 *   POST /api/fulfill   { kit, payment_id }
 *        Called by the site right after payment: checks the payment and
 *        emails the buyer their download link (once per payment).
 *   GET  /api/download?check=1
 *        Setup check: shows which settings work (never their values).
 *
 * Cloudflare → Workers & Pages → pixelift-studio → Settings → Variables and Secrets
 * (type: Secret):
 *   RAZORPAY_KEY_SECRET  Live Key Secret matching RAZORPAY_KEY_ID below
 *   KIT_DASHBOARD_URL    Google Drive share link to the zip ("Anyone with the link")
 *   EMAIL_SCRIPT_URL     Google Apps Script web-app URL that sends the purchase email
 *                        from your Gmail (see tools/gmail-sender.gs)
 *   EMAIL_SCRIPT_TOKEN   the password set in that script
 *   RESEND_API_KEY       optional alternative: resend.com API key
 *   EMAIL_FROM           optional, default "Pixelift Studio <orders@pixeliftstudio.uk>"
 *   EMAIL_REPLY_TO       optional, default hello@pixelift.studio
 */

const PRODUCTS = {
  "kit-dashboard": {
    name: "Motion Dashboard",
    file: "motion-dashboard.zip",
    urlSecret: "KIT_DASHBOARD_URL",
    amount: 90000, // paise (₹900)
    blurb: "One analytics dashboard with 15 buttery micro-animations — full HTML, CSS & JS source with a README.",
  },
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

// Public Razorpay Key ID (same as in assets/razorpay.js). The Key SECRET is a Worker secret.
const RAZORPAY_KEY_ID = "rzp_live_U2flCuJa3INWiY";

const SITE = "https://pixeliftstudio.uk";
const LINK_VALID_DAYS = 30;
const SUPPORT_EMAIL = "hello@pixelift.studio";
const DEFAULT_FROM = "Pixelift Studio <orders@pixeliftstudio.uk>";

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function handleDownload(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("check") === "1") return setupCheck(env);

  const kit = url.searchParams.get("kit") || "";
  const paymentId = url.searchParams.get("payment_id") || "";
  const v = await verifyPayment(env, kit, paymentId);
  if (v.error) return page(v.error.status, v.error.title, v.error.message);

  const file = await fetchFile(env, v.product);
  if (!file) {
    return page(503, "File temporarily unavailable", `Your payment is confirmed. Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) and we'll send the files right away.`);
  }
  const headers = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${v.product.file}"`,
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex",
  };
  if (file.size) headers["Content-Length"] = String(file.size);
  return new Response(file.body, { headers });
}

export async function handleFulfill(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const kit = String(body.kit || "");
  const paymentId = String(body.payment_id || "");
  const v = await verifyPayment(env, kit, paymentId);
  if (v.error) return json({ ok: false, error: v.error.title }, v.error.status);

  const { payment, product } = v;
  const downloadUrl = `${SITE}/api/download?kit=${encodeURIComponent(kit)}&payment_id=${encodeURIComponent(paymentId)}`;
  const to = String(payment.email || (payment.notes || {}).buyer_email || "").trim();
  const out = { ok: true, download_url: downloadUrl, email: maskEmail(to), emailed: false };

  if ((payment.notes || {}).emailed) return json({ ...out, emailed: true, already: true });
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !emailConfigured(env)) return json(out);

  const name = String((payment.notes || {}).buyer_name || "").trim();
  const sent = await sendEmail(env, {
    to,
    subject: `Your Pixelift order: ${product.name}`,
    html: emailHtml({ name, product, downloadUrl, paymentId, amount: payment.amount }),
    text: emailText({ name, product, downloadUrl, paymentId }),
  });
  if (sent) {
    out.emailed = true;
    // Mark the payment so the email is only sent once.
    await razorpay(env, `/payments/${paymentId}`, "PATCH", { notes: { ...(payment.notes || {}), emailed: "1" } }).catch(() => {});
  }
  return json(out);
}

/* ------------------------------------------------------------------ */
/* Payment check                                                       */
/* ------------------------------------------------------------------ */

async function verifyPayment(env, kit, paymentId) {
  const fail = (status, title, message) => ({ error: { status, title, message } });
  const product = PRODUCTS[kit];
  if (!product || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
    return fail(400, "Invalid download link", "This link is incomplete. Please use the link from your email or the Download button shown after payment.");
  }
  if (!keySecret(env) || (!env.KITS && !driveDirect(setting(env, product.urlSecret)))) {
    return fail(503, "Downloads are being set up", `Your payment is safe. Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) and we'll send your files.`);
  }

  let res, payment;
  try {
    res = await razorpay(env, `/payments/${paymentId}`);
  } catch (e) {
    return fail(502, "Couldn't verify payment", "Razorpay didn't respond. Please try again in a minute.");
  }
  if (res.status === 400 || res.status === 404) {
    return fail(404, "Payment not found", `We couldn't find this payment. Email ${SUPPORT_EMAIL} if you were charged.`);
  }
  if (!res.ok) return fail(502, "Couldn't verify payment", "Please try again in a minute.");
  payment = await res.json();

  const notes = payment.notes || {};
  const coupon = String(notes.coupon || "").toUpperCase();
  const priv = coupon ? PRIVATE_CODES[await sha256(coupon)] : undefined;
  const expected = priv !== undefined ? priv : Math.max(100, product.amount - (COUPONS[coupon] || 0));
  if (payment.amount !== expected || payment.currency !== "INR" || notes.product_id !== kit) {
    return fail(403, "Payment doesn't match this kit", `Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) and we'll sort it out.`);
  }

  // Payments are usually auto-captured. If this one is only authorised, capture it now.
  if (payment.status === "authorized") {
    const cap = await razorpay(env, `/payments/${paymentId}/capture`, "POST", { amount: payment.amount, currency: "INR" }).catch(() => null);
    if (cap && cap.ok) payment = await cap.json();
  }
  if (payment.status !== "captured") {
    return fail(402, "Payment not completed", "This payment hasn't gone through yet. If money was deducted, wait a minute and refresh this page.");
  }
  if ((Date.now() / 1000 - payment.created_at) / 86400 > LINK_VALID_DAYS) {
    return fail(410, "Download link expired", `Email ${SUPPORT_EMAIL} with your payment ID (${paymentId}) for a fresh copy.`);
  }
  return { payment, product };
}

function razorpay(env, path, method = "GET", body) {
  const init = { method, headers: { Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${keySecret(env)}`) } };
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(`https://api.razorpay.com/v1${path}`, init);
}

/* ------------------------------------------------------------------ */
/* File                                                                */
/* ------------------------------------------------------------------ */

async function fetchFile(env, product) {
  if (env.KITS) {
    const obj = await env.KITS.get(product.file);
    if (obj) return { body: obj.body, size: obj.size };
  }
  const src = driveDirect(setting(env, product.urlSecret));
  if (!src) return null;
  try {
    const r = await fetch(src, { redirect: "follow" });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || type.includes("text/html")) return null; // Drive returned a page instead of the file
    return { body: r.body, size: Number(r.headers.get("content-length")) || 0 };
  } catch (e) {
    return null;
  }
}

// Turn a Google Drive share link into a direct-download link; other URLs pass through.
function driveDirect(link) {
  if (!link) return "";
  link = String(link).trim();
  const m = link.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return /^https:\/\//.test(link) ? link : "";
}

/* ------------------------------------------------------------------ */
/* Email (Resend)                                                      */
/* ------------------------------------------------------------------ */

function emailConfigured(env) {
  return Boolean(setting(env, "RESEND_API_KEY") || (setting(env, "EMAIL_SCRIPT_URL") && setting(env, "EMAIL_SCRIPT_TOKEN")));
}

async function sendEmail(env, msg) {
  if (setting(env, "EMAIL_SCRIPT_URL") && setting(env, "EMAIL_SCRIPT_TOKEN")) return sendViaGmailScript(env, msg);
  if (setting(env, "RESEND_API_KEY")) return sendViaResend(env, msg);
  return false;
}

// Your own Google Apps Script (tools/gmail-sender.gs) sends the email from your Gmail.
async function sendViaGmailScript(env, { to, subject, html, text }) {
  try {
    const r = await fetch(String(setting(env, "EMAIL_SCRIPT_URL")).trim(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: String(setting(env, "EMAIL_SCRIPT_TOKEN")).trim(),
        to,
        subject,
        html,
        text,
        name: "Pixelift Studio",
        replyTo: setting(env, "EMAIL_REPLY_TO") || "",
      }),
      redirect: "follow",
    });
    const d = await r.json().catch(() => ({}));
    return Boolean(d && d.ok);
  } catch (e) {
    return false;
  }
}

async function sendViaResend(env, { to, subject, html, text }) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${String(setting(env, "RESEND_API_KEY")).trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: setting(env, "EMAIL_FROM") || DEFAULT_FROM,
        to: [to],
        reply_to: setting(env, "EMAIL_REPLY_TO") || SUPPORT_EMAIL,
        subject,
        html,
        text,
      }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// Kept deliberately simple (light, mostly text, one link) — heavy dark HTML and big
// buttons look like marketing to spam filters.
function emailHtml({ name, product, downloadUrl, paymentId, amount }) {
  const first = name ? esc(name.split(" ")[0]) : "there";
  const price = `₹${(amount / 100).toLocaleString("en-IN")}`;
  return `<!doctype html><html><body style="margin:0;padding:24px 16px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:15px;line-height:1.6">
<div style="max-width:560px;margin:0 auto">
<p style="margin:0 0 16px">Hi ${first},</p>
<p style="margin:0 0 16px">Thank you for buying <b>${esc(product.name)}</b> from Pixelift Studio. Your files are ready.</p>
<p style="margin:0 0 8px"><a href="${esc(downloadUrl)}" style="color:#5b3fd6;font-weight:bold">Download ${esc(product.file)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#555555">If the link doesn't open, copy this address into your browser:<br><span style="word-break:break-all">${esc(downloadUrl)}</span></p>
<p style="margin:0 0 16px">Unzip the folder and open <b>index.html</b>. The README explains every animation. The link works for ${LINK_VALID_DAYS} days.</p>
<p style="margin:0 0 16px;font-size:13px;color:#555555">Order details: ${esc(product.name)} · ${price} · Payment ID ${esc(paymentId)}</p>
<p style="margin:0 0 4px">If you have any questions, just reply to this email.</p>
<p style="margin:0 0 24px">Thanks,<br>Pixelift Studio</p>
<p style="margin:0;font-size:12px;color:#888888">You're receiving this email because you bought ${esc(product.name)} on pixeliftstudio.uk.</p>
</div></body></html>`;
}

function emailText({ name, product, downloadUrl, paymentId }) {
  return `Hi ${name ? name.split(" ")[0] : "there"},

Thank you for buying ${product.name} from Pixelift Studio. Your files are ready.

Download ${product.file}:
${downloadUrl}

Unzip the folder and open index.html. The README explains every animation. The link works for ${LINK_VALID_DAYS} days.

Payment ID: ${paymentId}

If you have any questions, just reply to this email.

Thanks,
Pixelift Studio

You're receiving this email because you bought ${product.name} on pixeliftstudio.uk.`;
}

/* ------------------------------------------------------------------ */
/* Setup check                                                         */
/* ------------------------------------------------------------------ */

async function setupCheck(env) {
  const raw = setting(env, "KIT_DASHBOARD_URL");
  const secret = keySecret(env);
  const rows = [
    ["Key ID (in code)", RAZORPAY_KEY_ID.slice(0, 13) + "…"],
    ["RAZORPAY_KEY_SECRET", secret ? "OK" : "MISSING"],
    ["KIT_DASHBOARD_URL", raw ? (driveDirect(raw) ? "OK" : "set, but not a valid https / Google Drive link") : "MISSING"],
    ["Email", setting(env, "EMAIL_SCRIPT_URL") ? (setting(env, "EMAIL_SCRIPT_TOKEN") ? "Gmail script set" : "EMAIL_SCRIPT_TOKEN MISSING") : setting(env, "RESEND_API_KEY") ? "Resend set" : "not set up — buyers won't get an email"],
  ];
  if (secret) {
    let status = "unreachable";
    try {
      const r = await razorpay(env, "/payments?count=1");
      status = r.ok ? "OK" : r.status === 401 ? "REJECTED — Key Secret doesn't match the Key ID" : `error ${r.status}`;
    } catch (e) {}
    rows.push(["Razorpay login", status]);
  }
  if (raw && driveDirect(raw)) {
    const f = await fetchFile(env, PRODUCTS["kit-dashboard"]);
    rows.push(["Drive file", f ? "OK (downloads as a zip)" : "NOT DOWNLOADABLE — check the Drive link is shared as “Anyone with the link”"]);
  }
  return page(200, "Download setup check", rows.map((r) => `${r[0]}: ${r[1]}`).join("  ·  "));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Read a setting by name, forgiving case and "-" vs "_" (e.g. Kit-dashboard-url).
function setting(env, name) {
  if (env[name]) return env[name];
  const want = name.toLowerCase().replace(/-/g, "_");
  for (const k of Object.keys(env)) {
    if (k.trim().toLowerCase().replace(/-/g, "_") === want && typeof env[k] === "string") return env[k];
  }
  return undefined;
}

// The Key Secret, wherever it was saved. Values that look like a Key ID (rzp_…) are skipped,
// so it still works if the ID and secret were saved under each other's names.
function keySecret(env) {
  for (const v of [setting(env, "RAZORPAY_KEY_SECRET"), setting(env, "RAZORPAY_KEY_ID")]) {
    if (v && !/^\s*rzp_/.test(v)) return String(v).trim();
  }
  return "";
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskEmail(e) {
  const [u, d] = String(e).split("@");
  if (!u || !d) return "";
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, u.length - 2))}@${d}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function page(status, title, message) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Pixelift Studio</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#07070d;color:#f4f2fb;font:16px/1.55 Inter,system-ui,sans-serif}
.b{max-width:440px;background:#12121c;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:28px}h1{margin:0 0 10px;font-size:22px}p{margin:0 0 20px;color:#9b97ad}
a{display:inline-block;padding:12px 20px;border-radius:99px;font-weight:700;color:#fff;text-decoration:none;background:linear-gradient(90deg,#ff3d7f,#8b5cf6)}</style></head>
<body><div class="b"><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">Back to Pixelift</a></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
