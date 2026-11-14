import type { IconName } from '../components/icons.js';

export type FileTone =
	| 'tone-folder'
	| 'tone-image'
	| 'tone-video'
	| 'tone-audio'
	| 'tone-archive'
	| 'tone-code'
	| 'tone-doc'
	| 'tone-pdf'
	| 'tone-generic';

export interface FileKind {
	icon: IconName;
	tone: FileTone;
	label: string;
}

const EXTENSION_KINDS: Record<string, FileKind> = {
	pdf: { icon: 'filePdf', tone: 'tone-pdf', label: 'PDF' },
	doc: { icon: 'fileWord', tone: 'tone-doc', label: 'Word' },
	docx: { icon: 'fileWord', tone: 'tone-doc', label: 'Word' },
	odt: { icon: 'fileWord', tone: 'tone-doc', label: 'Văn bản' },
	rtf: { icon: 'fileLines', tone: 'tone-doc', label: 'Văn bản' },
	txt: { icon: 'fileLines', tone: 'tone-doc', label: 'Văn bản' },
	md: { icon: 'fileCode', tone: 'tone-code', label: 'Markdown' },
	csv: { icon: 'fileExcel', tone: 'tone-doc', label: 'CSV' },
	xls: { icon: 'fileExcel', tone: 'tone-doc', label: 'Excel' },
	xlsx: { icon: 'fileExcel', tone: 'tone-doc', label: 'Excel' },
	ods: { icon: 'fileExcel', tone: 'tone-doc', label: 'Excel' },
	ppt: { icon: 'fileLines', tone: 'tone-doc', label: 'PowerPoint' },
	pptx: { icon: 'fileLines', tone: 'tone-doc', label: 'PowerPoint' },
	odp: { icon: 'fileLines', tone: 'tone-doc', label: 'PowerPoint' },
	jpg: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	jpeg: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	png: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	gif: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	webp: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	svg: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	avif: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	heic: { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
	mp4: { icon: 'fileVideo', tone: 'tone-video', label: 'Video' },
	mkv: { icon: 'fileVideo', tone: 'tone-video', label: 'Video' },
	mov: { icon: 'fileVideo', tone: 'tone-video', label: 'Video' },
	webm: { icon: 'fileVideo', tone: 'tone-video', label: 'Video' },
	avi: { icon: 'fileVideo', tone: 'tone-video', label: 'Video' },
	mp3: { icon: 'fileAudio', tone: 'tone-audio', label: 'Âm thanh' },
	wav: { icon: 'fileAudio', tone: 'tone-audio', label: 'Âm thanh' },
	flac: { icon: 'fileAudio', tone: 'tone-audio', label: 'Âm thanh' },
	m4a: { icon: 'fileAudio', tone: 'tone-audio', label: 'Âm thanh' },
	zip: { icon: 'fileZipper', tone: 'tone-archive', label: 'ZIP' },
	rar: { icon: 'fileZipper', tone: 'tone-archive', label: 'RAR' },
	'7z': { icon: 'fileZipper', tone: 'tone-archive', label: 'Archive' },
	tar: { icon: 'fileZipper', tone: 'tone-archive', label: 'Archive' },
	gz: { icon: 'fileZipper', tone: 'tone-archive', label: 'Archive' },
	js: { icon: 'fileCode', tone: 'tone-code', label: 'JavaScript' },
	jsx: { icon: 'fileCode', tone: 'tone-code', label: 'JavaScript' },
	ts: { icon: 'fileCode', tone: 'tone-code', label: 'TypeScript' },
	tsx: { icon: 'fileCode', tone: 'tone-code', label: 'TypeScript' },
	py: { icon: 'fileCode', tone: 'tone-code', label: 'Python' },
	go: { icon: 'fileCode', tone: 'tone-code', label: 'Go' },
	rs: { icon: 'fileCode', tone: 'tone-code', label: 'Rust' },
	java: { icon: 'fileCode', tone: 'tone-code', label: 'Java' },
	c: { icon: 'fileCode', tone: 'tone-code', label: 'C' },
	cpp: { icon: 'fileCode', tone: 'tone-code', label: 'C++' },
	html: { icon: 'fileCode', tone: 'tone-code', label: 'HTML' },
	css: { icon: 'fileCode', tone: 'tone-code', label: 'CSS' },
	json: { icon: 'fileCode', tone: 'tone-code', label: 'JSON' },
	yml: { icon: 'fileCode', tone: 'tone-code', label: 'YAML' },
	yaml: { icon: 'fileCode', tone: 'tone-code', label: 'YAML' },
	sql: { icon: 'fileCode', tone: 'tone-code', label: 'SQL' },
	sh: { icon: 'fileCode', tone: 'tone-code', label: 'Shell' },
	iso: { icon: 'fileZipper', tone: 'tone-archive', label: 'Disc image' },
};

const MIME_KINDS: Record<string, FileKind> = {
	'application/pdf': { icon: 'filePdf', tone: 'tone-pdf', label: 'PDF' },
	'application/json': { icon: 'fileCode', tone: 'tone-code', label: 'JSON' },
	'application/zip': { icon: 'fileZipper', tone: 'tone-archive', label: 'ZIP' },
	'application/x-tar': { icon: 'fileZipper', tone: 'tone-archive', label: 'Archive' },
	'application/gzip': { icon: 'fileZipper', tone: 'tone-archive', label: 'Archive' },
	'image/svg+xml': { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' },
};

const IMAGE_PREFIX = 'image/';
const VIDEO_PREFIX = 'video/';
const AUDIO_PREFIX = 'audio/';

export function fileKind(name: string, contentType?: string | null): FileKind {
	const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
	if (extension && EXTENSION_KINDS[extension]) return EXTENSION_KINDS[extension]!;
	const mime = (contentType ?? '').toLowerCase();
	if (mime && MIME_KINDS[mime]) return MIME_KINDS[mime]!;
	if (mime.startsWith(IMAGE_PREFIX)) return { icon: 'fileImage', tone: 'tone-image', label: 'Ảnh' };
	if (mime.startsWith(VIDEO_PREFIX)) return { icon: 'fileVideo', tone: 'tone-video', label: 'Video' };
	if (mime.startsWith(AUDIO_PREFIX)) return { icon: 'fileAudio', tone: 'tone-audio', label: 'Âm thanh' };
	if (mime.includes('word') || mime.includes('opendocument.text')) {
		return { icon: 'fileWord', tone: 'tone-doc', label: 'Văn bản' };
	}
	if (mime.includes('sheet') || mime.includes('opendocument.spreadsheet') || mime.includes('excel')) {
		return { icon: 'fileExcel', tone: 'tone-doc', label: 'Bảng tính' };
	}
	if (mime.includes('presentation') || mime.includes('opendocument.presentation')) {
		return { icon: 'fileLines', tone: 'tone-doc', label: 'Trình chiếu' };
	}
	if (mime.startsWith('text/')) return { icon: 'fileLines', tone: 'tone-doc', label: 'Văn bản' };
	return { icon: 'file', tone: 'tone-generic', label: 'Tệp' };
}
