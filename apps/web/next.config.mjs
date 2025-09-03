/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  env: {
    NEXT_PUBLIC_ENABLE_GITHUB: process.env.NEXT_PUBLIC_ENABLE_GITHUB,
  },
};

export default nextConfig;
