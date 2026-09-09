import { defineConfig } from 'vite'

// Vercel 빌드 환경이 주는 커밋 해시를 번들에 심는다 (오류 신고 진단 정보용).
// 로컬 dev 서버에서는 'dev'.
const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev'

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(commit),
  },
})
