/*
 * Pixelift Studio — Razorpay Checkout integration
 *
 * Hooks the existing "Get the code" kit buttons and the Bundle / All-access
 * pricing buttons into Razorpay Checkout (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/).
 *
 * SETUP: put your Key ID (Razorpay Dashboard → Account & Settings → API Keys)
 * in RAZORPAY_CONFIG.key below. Use rzp_test_… while testing, rzp_live_… in production.
 * Never put the Key SECRET in this file — it is public.
 */
(function () {
  "use strict";

  var RAZORPAY_CONFIG = {
    key: "rzp_live_U2UmdUhr1QCTTZ",
    businessName: "Pixelift Studio",
    logo: "", // optional: absolute URL of a square logo
    themeColor: "#8b5cf6",
    supportEmail: "hello@pixelift.studio",
  };

  // Amounts are in rupees here; converted to paise when opening checkout.
  // `download` is where the buyer is sent after a successful payment —
  // replace with your real file links (Google Drive, Gumroad file, S3, etc.).
  var PRODUCTS = {
    "kit-dashboard": { name: "Motion Dashboard", price: 900, secure: true, slug: "dashboard" },
  };

  // Discount codes: rupees off the price. Keep in sync with COUPONS in worker/download.js.
  // These are visible to anyone reading this file, so only use codes you share publicly.
  var COUPONS = {
    INSTA: { off: 100, label: "Instagram offer" },
  };

  // Direct-checkout links, e.g. https://pixeliftstudio.uk/?buy=dashboard&code=INSTA&src=reel12
  // buy  = product slug (opens the order screen right away)
  // code = discount code to pre-apply (optional)
  // src  = where the buyer came from; saved on the Razorpay payment (optional)

  var PLAN_CTAS = {};
  var params = new URLSearchParams(location.search);
  var SOURCE = (params.get("src") || params.get("utm_source") || "").slice(0, 40);

  function inr(n) { return "₹" + Number(n).toLocaleString("en-IN"); }
  function findCoupon(code) {
    code = String(code || "").trim().toUpperCase();
    return COUPONS[code] ? { code: code, off: COUPONS[code].off, label: COUPONS[code].label } : null;
  }

  var sdkPromise = null;
  function loadSdk() {
    if (window.Razorpay) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { sdkPromise = null; reject(new Error("Razorpay failed to load")); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  function productFromClick(target) {
    var link = target.closest && target.closest("a");
    if (!link) return null;
    var href = link.getAttribute("href") || "";
    if (href.indexOf("#kit-") === 0) return href.slice(1);
    if (link.closest(".plan")) {
      var label = (link.textContent || "").trim().toLowerCase();
      return PLAN_CTAS[label] || null;
    }
    return null;
  }

  function openCheckout(productId, coupon) {
    var product = PRODUCTS[productId];
    if (!product) return;
    var amount = Math.max(1, product.price - (coupon ? coupon.off : 0));
    var notes = { product_id: productId };
    if (coupon) notes.coupon = coupon.code;
    if (SOURCE) notes.source = SOURCE;

    if (RAZORPAY_CONFIG.key.indexOf("REPLACE") !== -1) {
      showModal({
        title: "Payments not configured",
        body: "Add your Razorpay Key ID in assets/razorpay.js to enable checkout.",
      });
      return;
    }

    loadSdk().then(function () {
      var rzp = new window.Razorpay({
        key: RAZORPAY_CONFIG.key,
        amount: amount * 100, // paise
        currency: "INR",
        name: RAZORPAY_CONFIG.businessName,
        description: product.name + (coupon ? " (" + coupon.code + ")" : ""),
        image: RAZORPAY_CONFIG.logo || undefined,
        notes: notes,
        theme: { color: RAZORPAY_CONFIG.themeColor },
        handler: function (response) {
          onSuccess(productId, product, response);
        },
        modal: { confirm_close: true },
      });
      rzp.on("payment.failed", function (resp) {
        var reason = (resp && resp.error && resp.error.description) || "The payment could not be completed.";
        showModal({ title: "Payment failed", body: reason + " No money was taken — please try again." });
      });
      rzp.open();
    }).catch(function () {
      showModal({
        title: "Couldn't open checkout",
        body: "Please check your connection and try again, or email " + RAZORPAY_CONFIG.supportEmail + ".",
      });
    });
  }

  // ---------- Order screen: price + discount code, then Razorpay ----------
  function showOrder(productId, presetCode) {
    var product = PRODUCTS[productId];
    if (!product) return;
    injectStyles();
    var coupon = findCoupon(presetCode);

    var overlay = el("div", "rzp-px-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var box = el("div", "rzp-px-box");
    var kicker = el("div", "rzp-px-kicker", "Your order");
    var title = el("h3", "", product.name);
    var line = el("div", "rzp-px-line");
    var lbl = el("span", "", "15 animations · full source + README");
    var price = el("b", "rzp-px-price");
    line.appendChild(lbl); line.appendChild(price);

    var form = el("form", "rzp-px-code");
    var input = el("input");
    input.type = "text"; input.placeholder = "Discount code"; input.autocomplete = "off";
    input.setAttribute("aria-label", "Discount code");
    input.value = coupon ? coupon.code : (presetCode || "");
    var apply = el("button", "rzp-px-btn ghost", "Apply");
    apply.type = "submit";
    form.appendChild(input); form.appendChild(apply);
    var msg = el("p", "rzp-px-msg");

    var row = el("div", "rzp-px-row");
    var pay = el("button", "rzp-px-btn rzp-px-pay");
    pay.type = "button";
    var cancel = el("button", "rzp-px-btn ghost", "Cancel");
    cancel.type = "button";
    row.appendChild(pay); row.appendChild(cancel);
    var secure = el("p", "rzp-px-note", "🔒 Secure payment by Razorpay · UPI, cards, netbanking. Instant download after payment.");

    [kicker, title, line, form, msg, row, secure].forEach(function (n) { box.appendChild(n); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function render() {
      var total = Math.max(1, product.price - (coupon ? coupon.off : 0));
      price.innerHTML = "";
      if (coupon) { var old = el("s", "", inr(product.price)); price.appendChild(old); price.appendChild(document.createTextNode(" ")); }
      price.appendChild(document.createTextNode(inr(total)));
      pay.textContent = "Pay " + inr(total) + " →";
    }
    function applyCode() {
      var v = input.value.trim();
      if (!v) { coupon = null; msg.textContent = ""; msg.className = "rzp-px-msg"; render(); return; }
      var c = findCoupon(v);
      if (c) { coupon = c; msg.textContent = "✓ " + c.code + " applied — you save " + inr(c.off); msg.className = "rzp-px-msg ok"; }
      else { coupon = null; msg.textContent = "That code isn't valid."; msg.className = "rzp-px-msg err"; }
      render();
    }
    if (presetCode) applyCode(); else render();

    function dismiss() { overlay.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") dismiss(); }
    form.addEventListener("submit", function (e) { e.preventDefault(); applyCode(); });
    pay.addEventListener("click", function () { dismiss(); openCheckout(productId, coupon); });
    cancel.addEventListener("click", dismiss);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) dismiss(); });
    document.addEventListener("keydown", onKey);
    pay.focus();
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function onSuccess(productId, product, response) {
    var id = response.razorpay_payment_id;
    var href = product.secure
      ? "/api/download?kit=" + encodeURIComponent(productId) + "&payment_id=" + encodeURIComponent(id)
      : product.download;
    var body =
      "Thanks for buying " + product.name + ". Your payment ID is " + id +
      " — keep it for support. A receipt has been emailed to you.";
    showModal({
      title: "Payment successful 🎉",
      body: body,
      action: href ? { label: "Download now", href: href } : null,
      footnote: href ? "Bookmark this link — it works for 30 days." : "We'll email your download link shortly.",
    });
  }

  // ---------- Small modal that matches the site's dark theme ----------
  function injectStyles() {
    if (document.getElementById("rzp-px-styles")) return;
    var css =
      ".rzp-px-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(7,7,13,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}" +
      ".rzp-px-box{width:100%;max-width:420px;background:var(--panel,#12121c);color:var(--text,#f4f2fb);border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:20px;padding:28px;font-family:Inter,system-ui,sans-serif;box-shadow:0 30px 80px rgba(0,0,0,.5)}" +
      ".rzp-px-box h3{margin:0 0 10px;font:700 22px/1.2 var(--display,'Space Grotesk',Inter,sans-serif)}" +
      ".rzp-px-box p{margin:0 0 20px;color:var(--muted,#9b97ad);line-height:1.55;font-size:15px;overflow-wrap:anywhere}" +
      ".rzp-px-row{display:flex;gap:10px;flex-wrap:wrap}" +
      ".rzp-px-btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 20px;border-radius:99px;font-weight:700;font-size:15px;color:#fff;text-decoration:none;border:0;cursor:pointer;background:linear-gradient(90deg,var(--pink,#ff3d7f),var(--purple,#8b5cf6))}" +
      ".rzp-px-btn.ghost{background:rgba(255,255,255,.04);border:1px solid var(--line2,rgba(255,255,255,.14))}" +
      ".rzp-px-note{margin:14px 0 0!important;font-size:13px!important}" +
      ".rzp-px-kicker{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--teal,#14b8a6);font-weight:700;margin-bottom:6px}" +
      ".rzp-px-line{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:14px 0;margin-bottom:16px;border-top:1px solid var(--line,rgba(255,255,255,.08));border-bottom:1px solid var(--line,rgba(255,255,255,.08));font-size:14px;color:var(--muted,#9b97ad)}" +
      ".rzp-px-price{font:700 26px var(--display,'Space Grotesk',Inter,sans-serif);color:var(--text,#f4f2fb);white-space:nowrap}" +
      ".rzp-px-price s{font-size:16px;color:var(--muted,#9b97ad);font-weight:500;margin-right:4px}" +
      ".rzp-px-code{display:flex;gap:8px;margin:0}" +
      ".rzp-px-code input{flex:1;min-width:0;height:46px;border-radius:12px;border:1px solid var(--line2,rgba(255,255,255,.14));background:rgba(0,0,0,.25);color:var(--text,#f4f2fb);padding:0 14px;font:600 15px Inter,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em}" +
      ".rzp-px-code input::placeholder{text-transform:none;letter-spacing:0;font-weight:500;color:#77738e}" +
      ".rzp-px-code input:focus{outline:none;border-color:var(--purple,#8b5cf6);box-shadow:0 0 0 3px rgba(139,92,246,.25)}" +
      ".rzp-px-code .rzp-px-btn{height:46px;padding:0 18px}" +
      ".rzp-px-box p.rzp-px-msg{min-height:20px;margin:8px 0 14px;font-size:13px}" +
      ".rzp-px-box p.rzp-px-msg.ok{color:#2dd4bf}.rzp-px-box p.rzp-px-msg.err{color:#ff5c8a}" +
      ".rzp-px-pay{flex:1}";
    var style = document.createElement("style");
    style.id = "rzp-px-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showModal(opts) {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "rzp-px-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var box = document.createElement("div");
    box.className = "rzp-px-box";

    var h = document.createElement("h3");
    h.textContent = opts.title;
    var p = document.createElement("p");
    p.textContent = opts.body;
    box.appendChild(h);
    box.appendChild(p);

    var row = document.createElement("div");
    row.className = "rzp-px-row";
    if (opts.action) {
      var a = document.createElement("a");
      a.className = "rzp-px-btn";
      a.href = opts.action.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = opts.action.label;
      row.appendChild(a);
    }
    var close = document.createElement("button");
    close.type = "button";
    close.className = "rzp-px-btn" + (opts.action ? " ghost" : "");
    close.textContent = "Close";
    row.appendChild(close);
    box.appendChild(row);

    if (opts.footnote) {
      var n = document.createElement("p");
      n.className = "rzp-px-note";
      n.textContent = opts.footnote;
      box.appendChild(n);
    }

    function dismiss() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") dismiss(); }
    close.addEventListener("click", dismiss);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) dismiss(); });
    document.addEventListener("keydown", onKey);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    close.focus();
  }

  // Capture phase so we run before the app's own scroll handlers.
  document.addEventListener(
    "click",
    function (e) {
      var productId = productFromClick(e.target);
      if (!productId) return;
      e.preventDefault();
      e.stopPropagation();
      showOrder(productId, params.get("code"));
    },
    true
  );

  // Direct-checkout link: ?buy=<slug> opens the order screen once the intro animation has played.
  var buy = (params.get("buy") || "").toLowerCase();
  if (buy) {
    var pid = Object.keys(PRODUCTS).filter(function (k) { return PRODUCTS[k].slug === buy || k === buy || k === "kit-" + buy; })[0];
    if (pid) {
      var start = function () { setTimeout(function () { showOrder(pid, params.get("code")); }, 1800); };
      if (document.readyState === "complete") start(); else window.addEventListener("load", start);
    }
  }

  // Warm up the SDK once the page is idle so checkout opens instantly.
  var warm = function () { loadSdk().catch(function () {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
})();
