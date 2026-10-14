import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

// 开发时：npm run dev（5173），接口转给后端 8765
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true, proxy: { "/api": { target: "http://127.0.0.1:8765", changeOrigin: true } } },
});
