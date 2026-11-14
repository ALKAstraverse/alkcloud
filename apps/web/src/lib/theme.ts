import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'alkcloud.theme';

function readStoredTheme(): Theme | null {
	try {
		const value = window.localStorage.getItem(STORAGE_KEY);
		if (value === 'light' || value === 'dark') return value;
	} catch {
		// localStorage bị chặn (private mode) — dùng theme hệ thống.
	}
	return null;
}

function systemTheme(): Theme {
	return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
	const root = document.documentElement;
	root.dataset.theme = theme;
	root.style.colorScheme = theme;
}

/**
 * Store nhỏ ngoài React để mọi component dùng `useTheme` thấy cùng một giá trị
 * (topbar ở FilesPage và mục Giao diện trong Settings không bị lệch icon).
 */
let currentTheme: Theme = typeof window === 'undefined' ? 'light' : (readStoredTheme() ?? systemTheme());
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function setTheme(theme: Theme): void {
	currentTheme = theme;
	applyTheme(theme);
	try {
		window.localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Bỏ qua — theme vẫn áp dụng cho phiên hiện tại.
	}
	emit();
}

if (typeof window !== 'undefined') {
	applyTheme(currentTheme);
	// Chưa có lựa chọn của user ⇒ bám theo hệ điều hành.
	window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
		if (readStoredTheme()) return;
		currentTheme = systemTheme();
		applyTheme(currentTheme);
		emit();
	});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (theme: Theme) => void } {
	const theme = useSyncExternalStore(
		subscribe,
		() => currentTheme,
		() => currentTheme,
	);
	return {
		theme,
		toggle: () => setTheme(currentTheme === 'dark' ? 'light' : 'dark'),
		setTheme,
	};
}
