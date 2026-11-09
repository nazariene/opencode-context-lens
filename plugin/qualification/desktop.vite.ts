import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "qualification/desktop",
  plugins: [solid()],
  build: { outDir: "../../dist/desktop-check", emptyOutDir: true },
});
