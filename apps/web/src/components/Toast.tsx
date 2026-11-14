import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon.js';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
	id: string;
	tone: ToastTone;
	title: string;
	message?: string;
}

interface ToastContextValue {
	toasts: Toast[];
	push: (toast: Omit<Toast, 'id'>) => void;
	dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
	success: 'circleCheck',
	error: 'circleXmark',
	warning: 'triangleExclamation',
	info: 'circleInfo',
};

const AUTO_DISMISS_MS: Record<ToastTone, number> = {
	success: 4000,
	info: 5000,
	warning: 7000,
	error: 8000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const timers = useRef(new Map<string, number>());

	const dismiss = useCallback((id: string) => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
		const timer = timers.current.get(id);
		if (timer) {
			window.clearTimeout(timer);
			timers.current.delete(id);
		}
	}, []);

	const push = useCallback(
		(toast: Omit<Toast, 'id'>) => {
			const id = `tst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
			setToasts((current) => [...current.slice(-3), { ...toast, id }]);
			const timer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[toast.tone]);
			timers.current.set(id, timer);
		},
		[dismiss],
	);

	const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

	return (
		<ToastContext.Provider value={value}>
			{children}
			<div className="toast-viewport" role="region" aria-label="Thông báo">
				{toasts.map((toast) => (
					<div key={toast.id} className={`toast toast--${toast.tone}`} role="status" aria-live="polite">
						<Icon name={TONE_ICON[toast.tone]} className="toast__icon" />
						<div className="toast__content">
							<div className="toast__title">{toast.title}</div>
							{toast.message ? <div className="toast__message">{toast.message}</div> : null}
						</div>
						<button
							type="button"
							className="toast__close"
							aria-label="Đóng thông báo"
							onClick={() => dismiss(toast.id)}
						>
							<Icon name="xmark" />
						</button>
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

export function useToast(): ToastContextValue {
	const context = useContext(ToastContext);
	if (!context) throw new Error('useToast phải nằm trong ToastProvider');
	return context;
}
