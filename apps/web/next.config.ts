import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === 'production' ? '.next-production' : '.next',
  serverExternalPackages: ['pg'],
  turbopack: { root: path.resolve(process.cwd(), '../..') },
  poweredByHeader: false,
};
export default nextConfig;
