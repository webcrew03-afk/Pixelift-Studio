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
    key: "rzp_test_REPLACE_WITH_YOUR_KEY_ID",
    businessName: "Pixelift Studio",
    logo: "", // optional: absolute URL of a square logo
    themeColor: "#8b5cf6",
    supportEmail: "hello@pixelift.studio",
  };

  // Amounts are in rupees here; converted to paise when opening checkout.
  // `download` is where the buyer is sent after a successful payment —
  // replace with your real file links (Google Drive, Gumroad file, S3, etc.).
  var PRODUCTS = {
    "kit-dashboard": { name: "Motion Dashboard", price: 3000, download: "" },
    "plan-bundle": { name: "Bundle — any 5 UI kits", price: 499, download: "" },
    "plan-all-access": { name: "All-access — 1 month", price: 299, download: "" },
  };

  // Pricing-card button text → product id ("Browse kits" keeps scrolling to the kits).
  var PLAN_CTAS = {
    "get the bundle": "plan-bundle",
    "go all-access": "plan-all-access",
  };

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

  function openCheckout(productId) {
    var product = PRODUCTS[productId];
    if (!product) return;

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
        amount: product.price * 100, // paise
        currency: "INR",
        name: RAZORPAY_CONFIG.businessName,
        description: product.name,
        image: RAZORPAY_CONFIG.logo || undefined,
        notes: { product_id: productId },
        theme: { color: RAZORPAY_CONFIG.themeColor },
        handler: function (response) {
          onSuccess(product, response);
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

  function onSuccess(product, response) {
    var id = response.razorpay_payment_id;
    var body =
      "Thanks for buying " + product.name + ". Your payment ID is " + id +
      " — keep it for support. A receipt has been emailed to you.";
    showModal({
      title: "Payment successful 🎉",
      body: body,
      action: product.download ? { label: "Download now", href: product.download } : null,
      footnote: product.download ? "" : "We'll email your download link shortly.",
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
      ".rzp-px-note{margin:14px 0 0!important;font-size:13px!important}";
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
      openCheckout(productId);
    },
    true
  );

  // Warm up the SDK once the page is idle so checkout opens instantly.
  var warm = function () { loadSdk().catch(function () {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
})();
