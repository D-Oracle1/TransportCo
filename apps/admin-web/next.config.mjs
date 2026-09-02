/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The shared workspace packages ship TypeScript-compiled CommonJS; Next needs
  // to transpile them rather than treat them as prebuilt externals.
  transpilePackages: ['@transportco/types', '@transportco/utils', '@transportco/config'],
  experimental: { typedRoutes: false },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
