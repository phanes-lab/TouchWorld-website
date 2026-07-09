import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/TouchWorld-website";

const nextConfig: NextConfig = {
  basePath,
  output: "export",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
