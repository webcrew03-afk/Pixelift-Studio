import { handleDownload } from "./download.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/download") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return handleDownload(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
