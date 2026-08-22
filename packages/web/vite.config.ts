import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const token = process.env.INFU_LOCAL_TOKEN;
  return {
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Keep the workbench shell small; expensive viewers load only when opened.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("mermaid")) return "mermaid";
          if (id.includes("streamdown") || id.includes("marked") || id.includes("shiki")) return "markdown";
          if (id.includes("@xterm")) return "terminal";
          if (id.includes("highlight.js")) return "highlight";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
        },
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true, // 端口被占用时直接报错而不是静默换端口
    proxy: {
      // Agent 服务（SSE 流式）
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
        // Standalone Vite development: start both processes with INFU_LOCAL_TOKEN.
        // The proxy adds it server-side so browser JS and image URLs never expose it.
        ...(token ? { headers: { "X-InFu-Token": token } } : {}),
      },
    },
  },
};
});
