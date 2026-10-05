import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite 为 Node 内置模块，仅在服务端路由中使用
  serverExternalPackages: [],
};

export default nextConfig;
