import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WS-L2 — Release manifest.
 *
 * Owner cần biết CHÍNH XÁC cái gì sẽ được deploy:
 *   - commit nào, có sạch (dirty) không
 *   - artifact nào, kích thước bao nhiêu, checksum ra sao
 *   - migration nào phải chạy TRƯỚC khi deploy (thứ tự, checksum)
 *   - secret nào phải có (chỉ TÊN, không giá trị)
 *   - route/worker nào bị ảnh hưởng
 *   - giới hạn bundle có vượt không
 *   - chất lượng: số test, có lỗi chặn không
 *
 * Chế độ `--verify`: tính lại checksum rồi so với manifest đã lưu ⇒ phát hiện
 * artifact bị sửa sau khi build (tam thổ) hoặc build không tái lập được.
 *
 * Action classification: READ_ONLY (đọc repo) + LOCAL_WRITE (ghi file trong repo).
 * KHÔNG gọi Cloudflare API, KHÔNG deploy, KHÔNG đọc secret.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RELEASE_DIR = join(ROOT, 'release');
const MANIFEST_JSON = join(RELEASE_DIR, 'manifest.json');
const MANIFEST_MD = join(RELEASE_DIR, 'MANIFEST.md');

/** Giới hạn bundle Worker (gzip) — Workers Free: 3 MiB. */
const WORKER_GZIP_LIMIT_BYTES = 3 * 1024 * 1024;
/** Giới hạn script Worker — Workers Free: 1 MiB. */
const WORKER_SCRIPT_LIMIT_BYTES = 1024 * 1024;

export interface ArtifactEntry {
	path: string;
	bytes: number;
	sha256: string;
}

export interface Manifest {
	version: string;
	generatedAt: string;
	git: { commit: string; branch: string; dirty: boolean; describe: string | null };
	toolchain: { node: string; npm: string };
	artifacts: ArtifactEntry[];
	bundles: { name: string; bytes: number; gzipBytes: number; limitBytes: number; withinLimit: boolean }[];
	migrations: { file: string; sha256: string }[];
	requiredSecrets: string[];
	deployment: {
		worker: string;
		routes: string[];
		crons: string[];
		d1Database: string;
		d1DatabaseId: string;
		/** `upload_source_maps = true` ⇒ mã nguồn được upload lên Cloudflare. */
		sourceMapsUploaded: boolean;
	};
	quality: { testCount: number | null; typecheck: 'pass' | 'unknown'; secretScan: 'pass' | 'unknown' };
	knownBlockers: { id: string; summary: string }[];
}

function git(args: string[]): string | null {
	try {
		return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

function parseWranglerToml(text: string): {
	worker: string;
	routes: string[];
	crons: string[];
	d1Database: string;
	d1DatabaseId: string;
	sourceMapsUploaded: boolean;
} {
	const worker = /name\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? 'unknown';
	const routes = [...text.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
	const crons = [...text.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)]
		.flatMap((m) => m[1]!.split(',').map((s) => s.trim().replace(/^"|"$/g, '')))
		.filter(Boolean);
	const d1Database = /database_name\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? 'unknown';
	const d1DatabaseId = /database_id\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? 'unknown';
	// `upload_source_maps = true` ⇒ Cloudflare nhận mã nguồn của bạn. Với sản
	// phẩm personal nhưng secret nằm ở Worker secret (không trong code) ⇒ vẫn
	// mặc định KHÔNG upload. Manifest ghi lại để owner thấy rõ.
	const sourceMapsUploaded = /upload_source_maps\s*=\s*true/.test(text);
	return { worker, routes, crons, d1Database, d1DatabaseId, sourceMapsUploaded };
}

/**
 * Secret bắt buộc — lấy từ chính `wrangler.toml` (không hardcode 2 nơi).
 * Chỉ trả về TÊN, không bao giờ giá trị.
 */
function requiredSecrets(wranglerText: string): string[] {
	const block = /# Secrets \(KHÔNG commit[^)]*\):([\s\S]*?)(?=\n\[|$)/.exec(wranglerText)?.[1] ?? '';
	return [...block.matchAll(/^\s*#\s*([A-Z][A-Z0-9_]{2,})\s*$/gm)].map((m) => m[1]!).sort();
}

function collectArtifacts(): ArtifactEntry[] {
	const targets = ['apps/api/dist', 'apps/web/dist'];
	const entries: ArtifactEntry[] = [];
	for (const target of targets) {
		const dir = join(ROOT, target);
		if (!existsSafe(dir)) continue;
		for (const file of walkFiles(dir).sort()) {
			entries.push({
				path: relative(ROOT, file),
				bytes: statSync(file).size,
				sha256: sha256File(file),
			});
		}
	}
	return entries;
}

function existsSafe(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function collectBundles(): Manifest['bundles'] {
	const bundles: Manifest['bundles'] = [];
	const apiDist = join(ROOT, 'apps/api/dist');
	if (!existsSafe(apiDist)) return bundles;
	for (const file of walkFiles(apiDist)) {
		if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
		const bytes = statSync(file).size;
		const gzipBytes = gzipSync(readFileSync(file)).length;
		// Script chính của Worker = file lớn nhất; áp giới hạn 3 MiB gzip cho
		// mọi bundle JS (Workers Free: 3 MiB compressed).
		bundles.push({
			name: relative(ROOT, file),
			bytes,
			gzipBytes,
			limitBytes: WORKER_GZIP_LIMIT_BYTES,
			withinLimit: gzipBytes <= WORKER_GZIP_LIMIT_BYTES,
		});
	}
	return bundles.sort((a, b) => b.gzipBytes - a.gzipBytes);
}

function collectMigrations(): Manifest['migrations'] {
	const dir = join(ROOT, 'apps/api/migrations');
	if (!existsSafe(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((file) => ({ file: `apps/api/migrations/${file}`, sha256: sha256File(join(dir, file)) }));
}

export function buildManifest(): Manifest {
	const wranglerText = readFileSync(join(ROOT, 'apps/api/wrangler.toml'), 'utf8');
	const status = git(['status', '--porcelain']);
	const npmVersion = git(['--version']); // fallback nếu không có npm
	return {
		version: (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version,
		generatedAt: new Date().toISOString(),
		git: {
			commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
			branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
			dirty: Boolean(status && status.length > 0),
			describe: git(['describe', '--tags', '--always']),
		},
		toolchain: {
			node: process.version,
			npm: npmVersion ?? 'unknown',
		},
		artifacts: collectArtifacts(),
		bundles: collectBundles(),
		migrations: collectMigrations(),
		requiredSecrets: requiredSecrets(wranglerText),
		deployment: {
			worker: parseWranglerToml(wranglerText).worker,
			routes: parseWranglerToml(wranglerText).routes,
			crons: parseWranglerToml(wranglerText).crons,
			d1Database: parseWranglerToml(wranglerText).d1Database,
			d1DatabaseId: parseWranglerToml(wranglerText).d1DatabaseId,
			sourceMapsUploaded: parseWranglerToml(wranglerText).sourceMapsUploaded,
		},
		quality: {
			testCount: null,
			typecheck: 'unknown',
			secretScan: 'unknown',
		},
		knownBlockers: [
			{ id: 'B3', summary: 'Chưa có B2 bucket + 2 app key' },
			{ id: 'B4', summary: 'Token Cloudflare thiếu Account Analytics:Read' },
			{ id: 'B6', summary: 'D1 database_id còn placeholder' },
			{ id: 'B7', summary: 'DNS cloud.alk.xx.kg chưa có' },
			{ id: 'B5', summary: 'Chưa chọn kênh alert' },
		],
	};
}

/** So manifest mới với manifest đã lưu ⇒ phát hiện artifact bị đổi. */
export function compareManifests(previous: Manifest, current: Manifest): string[] {
	const problems: string[] = [];
	const byPath = new Map(previous.artifacts.map((a) => [a.path, a]));
	for (const artifact of current.artifacts) {
		const before = byPath.get(artifact.path);
		if (!before) {
			problems.push(`artifact mới (không có trong manifest cũ): ${artifact.path}`);
			continue;
		}
		if (before.sha256 !== artifact.sha256) {
			problems.push(`checksum khác: ${artifact.path}`);
		}
		byPath.delete(artifact.path);
	}
	for (const removed of byPath.keys()) {
		problems.push(`artifact biến mất: ${removed}`);
	}
	if (previous.git.commit !== current.git.commit) {
		problems.push(`commit khác: ${previous.git.commit} → ${current.git.commit}`);
	}
	return problems;
}

export function renderMarkdown(manifest: Manifest): string {
	const lines: string[] = [];
	lines.push('# AlkCloud — Release Manifest');
	lines.push('');
	lines.push(`> Sinh tự động bởi \`npm run release:manifest\`. **KHÔNG sửa tay.**`);
	lines.push(`> Generated: ${manifest.generatedAt}`);
	lines.push('');
	lines.push('## 1. Thông tin bản phát hành');
	lines.push('');
	lines.push('| Trường | Giá trị |');
	lines.push('| :--- | :--- |');
	lines.push(`| Version | \`${manifest.version}\` |`);
	lines.push(`| Commit | \`${manifest.git.commit}\` |`);
	lines.push(`| Branch | \`${manifest.git.branch}\` |`);
	lines.push(`| Working tree | ${manifest.git.dirty ? '⚠️ **DIRTY** (có thay đổi chưa commit)' : 'sạch'} |`);
	lines.push(`| Node | \`${manifest.toolchain.node}\` |`);
	lines.push('');
	lines.push('## 2. Artifact + checksum');
	lines.push('');
	lines.push('| File | Bytes | SHA-256 |');
	lines.push('| :--- | ---: | :--- |');
	for (const artifact of manifest.artifacts) {
		lines.push(`| \`${artifact.path}\` | ${artifact.bytes} | \`${artifact.sha256}\` |`);
	}
	if (manifest.artifacts.length === 0) {
		lines.push('| _(chưa build)_ | — | — |');
	}
	lines.push('');
	lines.push('## 3. Giới hạn bundle (Workers Free)');
	lines.push('');
	lines.push('| Bundle | Bytes | Gzip | Trần gzip | OK |');
	lines.push('| :--- | ---: | ---: | ---: | :---: |');
	for (const bundle of manifest.bundles) {
		lines.push(
			`| \`${bundle.name}\` | ${bundle.bytes} | ${bundle.gzipBytes} | ${bundle.limitBytes} | ${bundle.withinLimit ? '✅' : '❌'} |`,
		);
	}
	lines.push('');
	lines.push('## 4. Migration (phải chạy TRƯỚC khi deploy)');
	lines.push('');
	lines.push('| # | File | SHA-256 |');
	lines.push('| ---: | :--- | :--- |');
	manifest.migrations.forEach((migration, index) => {
		lines.push(`| ${index + 1} | \`${migration.file}\` | \`${migration.sha256}\` |`);
	});
	lines.push('');
	lines.push('## 5. Secret bắt buộc (chỉ TÊN — không bao giờ ghi giá trị)');
	lines.push('');
	for (const secret of manifest.requiredSecrets) {
		lines.push(`- \`${secret}\``);
	}
	lines.push('');
	lines.push('## 6. Đích triển khai');
	lines.push('');
	lines.push('| Trường | Giá trị |');
	lines.push('| :--- | :--- |');
	lines.push(`| Worker | \`${manifest.deployment.worker}\` |`);
	lines.push(`| Route | ${manifest.deployment.routes.map((r) => `\`${r}\``).join(', ') || '—'} |`);
	lines.push(`| Cron | ${manifest.deployment.crons.map((c) => `\`${c}\``).join(', ') || '—'} |`);
	lines.push(`| D1 | \`${manifest.deployment.d1Database}\` (id: \`${manifest.deployment.d1DatabaseId}\`) |`);
	lines.push(
		`| Source map upload | ${manifest.deployment.sourceMapsUploaded ? '⚠️ **CÓ** (mã nguồn lên Cloudflare)' : 'không (đúng mặc định)'} |`,
	);
	lines.push('');
	lines.push('## 7. Blocker đã biết (phải xử lý trước production)');
	lines.push('');
	for (const blocker of manifest.knownBlockers) {
		lines.push(`- **${blocker.id}** — ${blocker.summary}`);
	}
	lines.push('');
	return lines.join('\n');
}

function main(): void {
	const args = process.argv.slice(2);
	const verify = args.includes('--verify');

	if (!existsSafe(join(ROOT, 'apps/api/dist'))) {
		console.error('Chưa có build — chạy `npm run build` trước.');
		process.exit(1);
	}

	const manifest = buildManifest();

	if (verify) {
		if (!existsSafe(MANIFEST_JSON)) {
			console.error('Chưa có release/manifest.json — chạy `npm run release:manifest` trước.');
			process.exit(1);
		}
		const previous = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8')) as Manifest;
		const problems = compareManifests(previous, manifest);
		if (problems.length > 0) {
			console.error('VERIFY FAIL — artifact/commit khác manifest đã lưu:');
			for (const problem of problems) console.error(`  - ${problem}`);
			process.exit(1);
		}
		console.log(`VERIFY OK — ${manifest.artifacts.length} artifact khớp checksum.`);
		console.log(`  commit ${manifest.git.commit} · version ${manifest.version}`);
		return;
	}

	mkdirSync(RELEASE_DIR, { recursive: true });
	writeFileSync(MANIFEST_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(MANIFEST_MD, renderMarkdown(manifest));

	console.log(`Release manifest đã tạo:`);
	console.log(`  release/manifest.json`);
	console.log(`  release/MANIFEST.md`);
	console.log(`  version ${manifest.version} · commit ${manifest.git.commit.slice(0, 12)}${manifest.git.dirty ? ' (DIRTY)' : ''}`);
	console.log(`  artifact: ${manifest.artifacts.length} file · migration: ${manifest.migrations.length} · secret: ${manifest.requiredSecrets.length}`);
	const oversized = manifest.bundles.filter((b) => !b.withinLimit);
	if (oversized.length > 0) {
		console.error(`  ❌ ${oversized.length} bundle vượt giới hạn Workers Free:`);
		for (const bundle of oversized) {
			console.error(`     ${bundle.name}: gzip ${bundle.gzipBytes} > ${bundle.limitBytes}`);
		}
		process.exit(1);
	}
	console.log('  ✅ mọi bundle trong giới hạn Workers Free (3 MiB gzip)');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
	main();
}
