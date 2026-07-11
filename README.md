# BGVanish

BGVanish is a Next.js 14 App Router web app for bulk background removal. It uses `@imgly/background-removal` in the browser, so images are processed on the user's device with no backend image pipeline or server processing cost.

## Features

- Drag-and-drop or click-to-browse upload for up to 250 JPG, PNG, JPEG, or WebP images.
- Client-side AI background removal through WASM.
- Batch processing with a concurrency limit of 3 images.
- Live progress, before/after previews, transparent checkerboard results, and per-file logs.
- Automatic ZIP download of all successful transparent PNG outputs via JSZip.
- Glassmorphism UI built with Tailwind CSS.

## Local Setup

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production Notes for IMG.LY Assets

`@imgly/background-removal` loads WASM/model assets in the browser. This app sets two headers in `next.config.mjs`:

```js
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Those headers help enable better WASM performance through cross-origin isolation.

The config also aliases `onnxruntime-web` and the package's conditional WebGPU import to `onnxruntime-web/wasm`. That keeps the app on the broad browser-compatible WASM runtime and avoids bundling the WebGPU entry in the Next.js 14 production build.

By default, BGVanish points the package at IMG.LY's hosted assets:

```txt
https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/
```

For production projects where you want to self-host the model/WASM files:

1. Download the asset package that matches the installed `@imgly/background-removal` version:

   ```txt
   https://staticimgly.com/@imgly/background-removal-data/1.7.0/package.tgz
   ```

2. Extract it.
3. Copy the extracted `package/dist` contents into a public folder, for example `public/imgly-background-removal/`.
4. Set this environment variable in local development and Vercel:

   ```bash
   NEXT_PUBLIC_IMGLY_BG_ASSET_PATH=/imgly-background-removal/
   ```

No API key is required. Image processing still happens entirely in the browser.

## Build

```bash
npm run build
```

## Deploy to Vercel Free Tier

1. Push this repository to GitHub.
2. Go to Vercel and choose **Add New Project**.
3. Import the GitHub repository.
4. Keep the framework preset as **Next.js**.
5. Use the default build command:

   ```bash
   npm run build
   ```

6. Use the default output settings.
7. Add `NEXT_PUBLIC_IMGLY_BG_ASSET_PATH` only if you self-host the IMG.LY assets.
8. Click **Deploy**.

The Vercel deployment runs a static/client-heavy Next.js app. Background removal work is performed by each user's browser, not by Vercel functions.
