import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Relative base: the build is served later as Worker static assets from any path.
	base: "./",
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	build: { target: "es2023", chunkSizeWarningLimit: 1500 },
	// Dev against a local Worker: `pnpm --filter worker dev` serves the API on :8787, so /api (REST and the WebSocket) goes there.
	server: { proxy: { "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:8787", ws: true, changeOrigin: true } } },
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		css: false,
		restoreMocks: true,
	},
});
