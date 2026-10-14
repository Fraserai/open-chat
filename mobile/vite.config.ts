import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
	plugins: [svelte()],
	server: { port: 5174, fs: { allow: [".."] }, proxy: { "/api": "http://127.0.0.1:3001" } },
	build: { outDir: "dist" },
	resolve: { alias: { $lib: new URL("../src/lib", import.meta.url).pathname } },
});
