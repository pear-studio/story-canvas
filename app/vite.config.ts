import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Tailscale Serve 会保留设备的 MagicDNS Host；只放行 Tailnet 使用的域名范围。
    allowedHosts: [".ts.net"],
    watch: {
      // 本机素材和运行产物不是前端源码；避免为大量文件建立监听，阻塞 Node 服务。
      ignored: ["data.local", "Saved", "workspace"].flatMap((directory) => [
        `**/${directory}`,
        `**/${directory}/**`,
      ]),
    },
  },
  build: {
    rollupOptions: { input: { main: "index.html", lettering: "finished-render.html" } },
    outDir: "dist",
    emptyOutDir: true,
  },
});
