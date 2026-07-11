import { createRequire } from "module";

const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin"
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "require-corp"
          }
        ]
      }
    ];
  },
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "onnxruntime-web$": require.resolve("onnxruntime-web/wasm"),
      "onnxruntime-web/webgpu$": require.resolve("onnxruntime-web/wasm"),
      sharp$: false
    };

    return config;
  }
};

export default nextConfig;
