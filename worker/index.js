import { handleDownload, handleFulfill } from "./download.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
