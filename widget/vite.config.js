import { defineConfig } from 'vite'

// Tauri 위젯 프론트엔드 빌드 설정.
// Tauri dev 서버가 고정 포트(1420)를 기대하므로 strictPort로 고정한다.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // 위젯 본체(index.html) + 종료 다이얼로그(finish.html) 멀티 페이지
      input: {
        main: 'index.html',
        finish: 'finish.html',
        swap: 'swap.html',
      },
    },
  },
})
