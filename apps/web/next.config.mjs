/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  allowedDevOrigins: [
    "localhost:58587",
    "127.0.0.1:58587",
    "localhost:3000",
    "127.0.0.1:3000",
  ],
};

export default nextConfig;
