import { handleDownload, handleFulfill } from "./download.js";

const SHORT_LINKS = {
  "/dashboard": "/?buy=dashboard",
  "/buy": "/?buy=dashboard",
  "/insta": "/?buy=dashboard&code=PIXELINSTA&src=instagram",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Short links for Instagram DMs and bio: pixeliftstudio.uk/dashboard, /insta
    const short = SHORT_LINKS[url.pathname.replace(/\/+$/, "").toLowerCase()];
    if (short) {
      const to = new URL(short, url.origin);
      for (const [k, v] of url.searchParams) to.searchParams.set(k, v); // e.g. /insta?src=reel5 overrides the source
      return Response.redirect(to.toString(), 302);
    }
    if (url.pathname === "/api/download") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return handleDownload(request, env);
    }
    if (url.pathname === "/api/fulfill") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleFulfill(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
