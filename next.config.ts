import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pakiety wymagające natywnego Node.js (nie mogą trafić do bundla edge / RSC).
  serverExternalPackages: ["imapflow", "mailparser", "svix"],
  // Panel jest prywatny i zawiera dane operacyjne — nie chcemy go w wynikach wyszukiwania.
  async headers() {
    return [
      {
        source: "/dashboard/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
