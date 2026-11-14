import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Build id hiển thị trên UI — giúp xác nhận trình duyệt đang chạy bundle mới. */
const BUILD_ID = process.env.BUILD_ID ?? new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

export default defineConfig({
	plugins: [react()],
	define: {
		__BUILD_ID__: JSON.stringify(BUILD_ID),
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		target: 'es2022',
		rollupOptions: {
			output: {
				manualChunks: {
					react: ['react', 'react-dom'],
				},
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:8787',
				changeOrigin: false,
			},
		},
	},
});
