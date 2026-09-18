import type { NextConfig } from "next";

// The Go API is the public entrypoint and reverse-proxies page requests here.
// In `next dev` (no Go proxy in front) we forward /api and /mcp to the API.
const apiUrl = process.env.DOCKHAND_API_URL ?? "http://localhost:8080";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
      { source: "/mcp", destination: `${apiUrl}/mcp` },
    ];
  },
};

export default config;
