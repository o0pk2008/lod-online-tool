import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

/**
 * Workspace root = this tool repository (input/, output/, public/).
 * Data paths and /repo serving are relative to this directory.
 */
const repoRoot = path.resolve(__dirname);
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 5178);

/**
 * Locate @playcanvas/splat-transform (or a local checkout) that provides bin/cli.mjs.
 * Priority:
 *   1. SPLAT_TRANSFORM_ROOT env
 *   2. Parent dir (when this repo sits inside splat-transform/)
 *   3. Sibling ../splat-transform
 *   4. node_modules/@playcanvas/splat-transform
 */
const resolveSplatTransformRoot = () => {
    const candidates = [];
    if (process.env.SPLAT_TRANSFORM_ROOT) {
        candidates.push(path.resolve(process.env.SPLAT_TRANSFORM_ROOT));
    }
    candidates.push(
        path.resolve(__dirname, '..'),
        path.resolve(__dirname, '../splat-transform'),
        path.resolve(__dirname, 'node_modules/@playcanvas/splat-transform')
    );
    try {
        const pkgJson = require.resolve('@playcanvas/splat-transform/package.json');
        candidates.push(path.dirname(pkgJson));
    } catch {
        // package not installed
    }

    for (const root of candidates) {
        if (existsSync(path.join(root, 'bin', 'cli.mjs'))) {
            return root;
        }
    }
    return null;
};

const splatTransformRoot = resolveSplatTransformRoot();
if (!splatTransformRoot) {
    console.warn(
        '[lod-online-tool] splat-transform CLI not found.\n' +
        '  Set SPLAT_TRANSFORM_ROOT to a local checkout, or run: npm install @playcanvas/splat-transform'
    );
}

/** Intermediate PLY keep-size threshold for browser preview (bytes). Larger files skip auto-preview. */
const PREVIEW_MAX_BYTES = 350 * 1024 * 1024;

/** Phase 1 (simplify intermediates) weight of overall progress bar */
const PHASE1_WEIGHT = 0.62;
/** Phase 2 (compose lod-meta) weight */
const PHASE2_WEIGHT = 0.38;

const DEFAULT_LEVELS = [
    { lod: 5, decimate: '15%', chunkCountK: 512 },
    { lod: 4, decimate: '25%', chunkCountK: 512 },
    { lod: 3, decimate: '40%', chunkCountK: 512 },
    { lod: 2, decimate: '60%', chunkCountK: 512 },
    { lod: 1, decimate: '80%', chunkCountK: 512 },
    { lod: 0, decimate: '', chunkCountK: 512 }
];

/** Compress-only mode: keep this fraction of Gaussians (1–99). */
const DEFAULT_KEEP_PERCENT = 60;
const COMPRESS_FILENAME = 'compressed.ply';
const COMPRESS_META_FILENAME = 'compress-meta.json';
const PREVIEW_ORIGINAL_SOG = 'preview-original.sog';
const PREVIEW_COMPRESSED_SOG = 'preview-compressed.sog';

const sseClients = new Set();
let activeRun = null;
/** Last finished/stopped run snapshot (for refresh after complete) */
let lastRunSnapshot = null;
let fileIdCounter = 1;
const fileRegistry = new Map();
/** @type {Map<string, string>} runId/token -> absolute output root */
const outputRoots = new Map();

const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ply': 'application/octet-stream',
    '.sog': 'application/octet-stream'
};

const sendJson = (res, statusCode, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
};

const normalizeRelPath = (targetPath) => {
    const resolved = path.resolve(repoRoot, targetPath);
    const rel = path.relative(repoRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Path must stay inside repository.');
    }
    return { resolved, rel: rel.replaceAll('\\', '/') };
};

const INPUT_UPLOAD_EXTS = ['.ply', '.sog', '.splat', '.spz', '.ksplat'];

const isAcceptedInputFileName = (fileName) => {
    const lower = `${fileName ?? ''}`.toLowerCase();
    if (lower.endsWith('.compressed.ply')) return true;
    return INPUT_UPLOAD_EXTS.some((ext) => lower.endsWith(ext));
};

const sanitizeUploadFileName = (fileName) => {
    const base = path.basename(`${fileName ?? ''}`.trim() || 'upload.ply');
    const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    return cleaned || 'upload.ply';
};

/** Accept Windows paths, POSIX paths, and file:/// URLs from Explorer drag-drop. */
const normalizeDroppedPath = (raw) => {
    let text = `${raw ?? ''}`.trim().replace(/^['"]+|['"]+$/g, '');
    if (!text) return '';
    if (text.startsWith('file:')) {
        try {
            return fileURLToPath(text);
        } catch {
            try {
                const decoded = decodeURIComponent(text.replace(/^file:\/\//i, ''));
                return decoded.replace(/^\/([A-Za-z]:)/, '$1');
            } catch {
                return text;
            }
        }
    }
    return text;
};

const isPathInside = (filePath, rootPath) => {
    const resolvedFile = path.resolve(filePath);
    const resolvedRoot = path.resolve(rootPath);
    const rel = path.relative(resolvedRoot, resolvedFile);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const sseBroadcast = (event, payload) => {
    // Keep UI snapshot in sync for page-refresh restore
    if (activeRun && payload && payload.runId === activeRun.runId) {
        trackRunEvent(activeRun, event, payload);
    }
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        client.write(line);
    }
};

const sseSend = (res, event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
};

const DONE_STATUSES = new Set(['已计算', '计算失败', '已停止']);

const trackTask = (runState, name, patch, { force = false } = {}) => {
    if (!name || !runState) return;
    if (!runState.tasks) runState.tasks = new Map();
    const prev = runState.tasks.get(name) || { progress: 0, status: '待计算' };

    // Never downgrade a finished task (refresh/snapshot bug source)
    if (!force && prev.status === '已计算') {
        return;
    }
    if (!force && DONE_STATUSES.has(prev.status) && patch.status && !DONE_STATUSES.has(patch.status)) {
        return;
    }

    const nextProgress = patch.progress != null ? patch.progress : prev.progress;
    const nextStatus = patch.status != null ? patch.status : prev.status;
    runState.tasks.set(name, {
        // progress only moves forward unless forced
        progress: force ? nextProgress : Math.max(prev.progress ?? 0, nextProgress ?? 0),
        status: nextStatus
    });
};

const markAllTasksDone = (runState) => {
    if (!runState?.tasks) return;
    for (const task of runState.tasks.values()) {
        if (task.status !== '计算失败' && task.status !== '已停止') {
            task.progress = 100;
            task.status = '已计算';
        }
    }
};

/**
 * Reconcile task list against files on disk so refresh doesn't stick at 95%/写入中.
 */
const reconcileTasksFromDisk = async (runState) => {
    if (!runState?.outputRootAbsPath) return;
    const root = runState.outputRootAbsPath;
    if (!runState.tasks) runState.tasks = new Map();

    // Intermediates
    const interDir = path.join(root, INTERMEDIATE_DIR);
    const interEntries = await safeReadDir(interDir);
    for (const entry of interEntries) {
        if (!entry.isFile()) continue;
        const m = /^L(\d+)\.ply$/i.exec(entry.name);
        if (!m) continue;
        const lod = Number(m[1]);
        const full = path.join(interDir, entry.name);
        const st = await stat(full).catch(() => null);
        if (st?.isFile() && st.size > 64) {
            trackTask(runState, `中间 L${lod}`, { progress: 100, status: '已计算' }, { force: true });
        }
    }

    // Chunk SOG folders: {lod}_{index}/meta.json written last by writeSog
    const rootEntries = await safeReadDir(root);
    for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue;
        const match = chunkDirNameRe.exec(entry.name);
        if (!match) continue;
        const metaPath = path.join(root, entry.name, 'meta.json');
        const metaStat = await stat(metaPath).catch(() => null);
        if (metaStat?.isFile() && metaStat.size > 2) {
            trackTask(runState, entry.name, { progress: 100, status: '已计算' }, { force: true });
        }
    }

    // L0 source placeholder
    if (runState.levels?.some((l) => Number(l.lod) === 0)) {
        trackTask(runState, 'L0 原文件', { progress: 100, status: '已计算' }, { force: true });
    }

    if (runState.mode === 'compress') {
        trackTask(runState, '原模型', { progress: 100, status: '已计算' }, { force: true });
        const compressedName = runState.compressedFileName || COMPRESS_FILENAME;
        const compressedPath = path.join(root, compressedName);
        const compressedStat = await stat(compressedPath).catch(() => null);
        if (compressedStat?.isFile() && compressedStat.size > 64) {
            trackTask(runState, '压缩输出', { progress: 100, status: '已计算' }, { force: true });
        }
    }

    if (runState.finished && !runState.cancelled && !runState.errorMessage) {
        markAllTasksDone(runState);
    }
};

const trackRunEvent = (runState, event, payload) => {
    switch (event) {
        case 'progress':
            if (payload.line) runState.lastLine = payload.line;
            if (payload.percent != null && Number.isFinite(payload.percent)) {
                runState.lastPercent = Math.max(runState.lastPercent ?? 0, payload.percent);
            }
            if (payload.phase != null) runState.phase = payload.phase;
            if (payload.lod != null) runState.currentLod = payload.lod;
            if (payload.chunkName && payload.chunkPercent != null) {
                // Do not pull a finished chunk back to "正在计算"
                trackTask(runState, payload.chunkName, {
                    progress: Math.min(99, Number(payload.chunkPercent)),
                    status: '正在计算'
                });
            }
            break;
        case 'phase-start':
            runState.phase = payload.phase;
            runState.lastLine = payload.title || runState.lastLine;
            break;
        case 'phase-complete':
            if (payload.percent != null) {
                runState.lastPercent = Math.max(runState.lastPercent ?? 0, payload.percent);
            }
            if (Number(payload.phase) === 1 && runState.tasks) {
                // All intermediate tasks that finished stay done; leave incomplete as-is
            }
            break;
        case 'intermediate-plan':
            trackTask(runState, payload.taskName || `中间 L${payload.lod}`, {
                progress: 0,
                status: '待计算'
            });
            break;
        case 'intermediate-start':
            runState.currentLod = payload.lod;
            trackTask(runState, payload.taskName || `中间 L${payload.lod}`, {
                progress: 5,
                status: '正在计算'
            });
            runState.lastLine = `阶段1 简化 L${payload.lod}（${payload.index}/${payload.total}）`;
            break;
        case 'intermediate-ready':
            trackTask(runState, payload.taskName || `中间 L${payload.lod}`, {
                progress: 100,
                status: '已计算'
            }, { force: true });
            break;
        case 'chunk-plan':
            (payload.chunkNames || []).forEach((name) => {
                trackTask(runState, name, { progress: 0, status: '待计算' });
            });
            break;
        case 'chunk-start':
            runState.currentChunkName = payload.chunkName;
            runState.currentLod = payload.lod;
            trackTask(runState, payload.chunkName, { progress: 1, status: '正在计算' });
            break;
        case 'chunk-ready':
            // meta.json exists => SOG write finished. Do NOT leave 95%/写入中 in snapshot.
            trackTask(runState, payload.chunkName, {
                progress: 100,
                status: '已计算'
            }, { force: true });
            break;
        case 'level-complete':
            if (runState.tasks) {
                for (const [name, task] of runState.tasks) {
                    if (name.startsWith(`${payload.lod}_`) || name === `中间 L${payload.lod}` || name === 'L0 原文件') {
                        task.progress = 100;
                        if (task.status !== '计算失败' && task.status !== '已停止') {
                            task.status = '已计算';
                        }
                    }
                }
            }
            break;
        case 'compress-plan':
            trackTask(runState, payload.taskName || '压缩输出', {
                progress: payload.taskName === '原模型' ? 100 : 0,
                status: payload.taskName === '原模型' ? '已计算' : '待计算'
            });
            break;
        case 'compress-start':
            trackTask(runState, payload.taskName || '压缩输出', {
                progress: 5,
                status: '正在计算'
            });
            runState.lastLine = `正在压缩（保留 ${payload.keepPercent ?? '?'}%）`;
            break;
        case 'compress-ready':
            trackTask(runState, '压缩输出', {
                progress: 100,
                status: '已计算'
            }, { force: true });
            if (payload.keepPercent != null) runState.keepPercent = payload.keepPercent;
            if (payload.originalUrl) runState.originalPreviewUrl = payload.originalUrl;
            if (payload.compressedUrl) runState.compressedPreviewUrl = payload.compressedUrl;
            if (payload.originalSizeBytes != null) runState.originalSizeBytes = payload.originalSizeBytes;
            if (payload.compressedSizeBytes != null) runState.compressedSizeBytes = payload.compressedSizeBytes;
            if (payload.originalCount != null) runState.originalCount = payload.originalCount;
            if (payload.compressedCount != null) runState.compressedCount = payload.compressedCount;
            break;
        case 'run-complete':
            runState.finished = true;
            runState.lastPercent = 100;
            runState.lastLine = runState.mode === 'compress' ? '模型压缩完成。' : '全部 LOD 计算完成。';
            markAllTasksDone(runState);
            break;
        case 'run-error':
            runState.finished = true;
            runState.errorMessage = payload.message;
            runState.lastLine = `运行失败: ${payload.message}`;
            break;
        case 'run-stopped':
            runState.finished = true;
            runState.cancelled = true;
            runState.lastLine = '任务已停止。';
            break;
        default:
            break;
    }
};

const getRunSnapshot = async (runState) => {
    if (!runState) return null;
    await reconcileTasksFromDisk(runState);
    if (runState.mode === 'compress') {
        await applyCompressPreviewUrls(runState);
    }
    const isActive = activeRun?.runId === runState.runId && !runState.finished;
    return {
        runId: runState.runId,
        active: isActive,
        status: runState.cancelled
            ? 'stopped'
            : runState.errorMessage
                ? 'error'
                : runState.finished
                    ? 'complete'
                    : 'running',
        inputPath: runState.inputPathDisplay || runState.inputAbsPath,
        inputPathAbs: runState.inputAbsPath,
        outputRoot: runState.outputRootDisplay,
        levels: runState.levels,
        chunkCountK: runState.chunkCountK,
        chunkExtent: runState.chunkExtent,
        phase: runState.phase ?? 0,
        lastPercent: runState.lastPercent ?? 0,
        lastLine: runState.lastLine || '',
        currentLod: runState.currentLod,
        currentChunkName: runState.currentChunkName,
        outputMetaUrl: runState.mode === 'compress' ? null : makeOutUrl(runState.runId, 'lod-meta.json'),
        intermediateDir: INTERMEDIATE_DIR,
        intermediateAbsDir: runState.outputRootAbsPath
            ? path.join(runState.outputRootAbsPath, INTERMEDIATE_DIR)
            : null,
        tasks: runState.tasks
            ? [...runState.tasks.entries()].map(([name, t]) => ({
                name,
                progress: t.progress,
                status: t.status
            }))
            : [],
        errorMessage: runState.errorMessage || null,
        pipeline: runState.mode === 'compress' ? 'compress' : 'two-phase',
        mode: runState.mode || 'lod',
        keepPercent: runState.keepPercent ?? null,
        originalPreviewUrl: runState.originalPreviewUrl || null,
        compressedPreviewUrl: runState.compressedPreviewUrl || null,
        originalSizeBytes: runState.originalSizeBytes ?? null,
        compressedSizeBytes: runState.compressedSizeBytes ?? null,
        originalCount: runState.originalCount ?? null,
        compressedCount: runState.compressedCount ?? null,
        skipOriginalPreview: runState.skipOriginalPreview ?? false,
        skipCompressedPreview: runState.skipCompressedPreview ?? false
    };
};

const registerServedFile = (absPath) => {
    const id = `f${fileIdCounter++}`;
    fileRegistry.set(id, absPath);
    return `/file/${id}`;
};

/**
 * Serve an input model for 3D preview: repo-relative via /repo, otherwise a tokenized /file URL.
 */
const makeInputPreviewUrl = (absPath) => {
    const resolved = path.resolve(absPath);
    try {
        const rel = path.relative(repoRoot, resolved).replaceAll('\\', '/');
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            return `/repo/${rel.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
        }
    } catch {
        // fall through to token URL
    }
    return registerServedFile(resolved);
};

const clampKeepPercent = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_KEEP_PERCENT;
    return Math.max(1, Math.min(99, Math.round(n)));
};

const readCompressMeta = async (metaPath) => {
    try {
        const parsed = JSON.parse(await readFile(metaPath, 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
};

const safeReadDir = async (dirPath) => {
    try {
        return await readdir(dirPath, { withFileTypes: true });
    } catch {
        return [];
    }
};

/**
 * Convert UI/API decimate values into CLI -F args.
 * Empty / 100% means "keep all" and should not invoke decimation.
 */
const normalizeDecimateArg = (decimate) => {
    const text = `${decimate ?? ''}`.trim();
    if (!text) return null;

    const withPct = text.endsWith('%') ? text : `${text}%`;
    const num = Number(withPct.slice(0, -1));
    if (!Number.isFinite(num) || num < 0 || num >= 100) {
        return null;
    }
    return withPct;
};

const chunkDirNameRe = /^(\d+)_(\d+)$/;
const INTERMEDIATE_DIR = '_intermediates';

const intermediateFileName = (lod) => `L${lod}.ply`;
const intermediateAbsPath = (outputRootAbsPath, lod) =>
    path.join(outputRootAbsPath, INTERMEDIATE_DIR, intermediateFileName(lod));

const isNonEmptyFile = async (filePath) => {
    try {
        const s = await stat(filePath);
        return s.isFile() && s.size > 64;
    } catch {
        return false;
    }
};

/**
 * True when lod-meta.json lists every required LOD and each has at least one complete chunk.
 */
const isLodOutputComplete = async (outputRootAbsPath, requiredLods) => {
    const metaPath = path.join(outputRootAbsPath, 'lod-meta.json');
    let parsed;
    try {
        parsed = JSON.parse(await readFile(metaPath, 'utf-8'));
    } catch {
        return false;
    }

    const filenames = Array.isArray(parsed?.filenames) ? parsed.filenames : [];
    const presentLods = new Set();
    for (const item of filenames) {
        const name = `${item ?? ''}`.split('/')[0];
        const match = chunkDirNameRe.exec(name);
        if (match) presentLods.add(Number(match[1]));
    }

    for (const lod of requiredLods) {
        if (!presentLods.has(lod)) return false;
    }

    for (const lod of requiredLods) {
        const entries = await safeReadDir(outputRootAbsPath);
        let found = false;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (!entry.name.startsWith(`${lod}_`)) continue;
            const metaStat = await stat(path.join(outputRootAbsPath, entry.name, 'meta.json')).catch(() => null);
            if (metaStat && metaStat.isFile() && metaStat.size > 2) {
                found = true;
                break;
            }
        }
        if (!found) return false;
    }

    return true;
};

/**
 * Levels that need a simplified intermediate file (all non-L0 with a real -F keep ratio).
 */
const getSimplifyLevels = (levels) =>
    levels
        .filter((level) => level.lod !== 0 && normalizeDecimateArg(level.decimate))
        .sort((a, b) => b.lod - a.lod);

/**
 * Remove final LOD chunk artifacts (keep or drop intermediates separately).
 */
const clearLodChunks = async (outputRootAbsPath) => {
    const entries = await safeReadDir(outputRootAbsPath);
    for (const entry of entries) {
        const full = path.join(outputRootAbsPath, entry.name);
        if (entry.name === 'lod-meta.json') {
            await rm(full, { force: true });
            continue;
        }
        if (entry.isDirectory() && (chunkDirNameRe.test(entry.name) || entry.name === 'env')) {
            await rm(full, { recursive: true, force: true });
        }
    }
};

const clearIntermediates = async (outputRootAbsPath) => {
    const dir = path.join(outputRootAbsPath, INTERMEDIATE_DIR);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
};

const makeOutUrl = (runId, ...parts) =>
    `/out/${encodeURIComponent(runId)}/${parts.map((p) => encodeURIComponent(p)).join('/')}`;

const makeChunkMetaUrl = (runId, chunkName) => makeOutUrl(runId, chunkName, 'meta.json');

const emitChunkPlan = async (runId, levelOutputDir, requiredLods) => {
    const metaPath = path.join(levelOutputDir, 'lod-meta.json');
    const metaText = await readFile(metaPath, 'utf-8').catch(() => null);
    if (!metaText) return false;

    try {
        const parsed = JSON.parse(metaText);
        const filenames = Array.isArray(parsed?.filenames) ? parsed.filenames : [];
        const required = new Set(requiredLods.map(Number));
        const chunkNames = filenames
            .map((item) => `${item ?? ''}`)
            .map((item) => item.split('/')[0])
            .filter((name) => {
                const match = chunkDirNameRe.exec(name);
                return match && required.has(Number(match[1]));
            });

        if (chunkNames.length === 0) return false;

        const unique = [...new Set(chunkNames)];
        sseBroadcast('chunk-plan', {
            runId,
            lod: null,
            chunkNames: unique
        });

        const byLod = new Map();
        for (const name of unique) {
            const lod = Number(name.split('_')[0]);
            if (!byLod.has(lod)) byLod.set(lod, []);
            byLod.get(lod).push(name);
        }
        for (const [lod, names] of byLod) {
            sseBroadcast('chunk-plan', {
                runId,
                lod,
                chunkNames: names
            });
        }
        return true;
    } catch {
        return false;
    }
};

const emitChunkReady = (runId, lod, chunkName) => {
    sseBroadcast('chunk-ready', {
        runId,
        lod,
        chunkName,
        metaUrl: makeChunkMetaUrl(runId, chunkName)
    });
};

const createChunkPoller = (runState, levelOutputDir, requiredLods) => {
    const sent = new Set();
    const required = new Set(requiredLods.map(Number));
    const startedLods = runState.startedLods;

    const timer = setInterval(async () => {
        if (!activeRun || activeRun.runId !== runState.runId) {
            clearInterval(timer);
            return;
        }

        if (!runState.sentChunkPlan) {
            const sentPlan = await emitChunkPlan(runState.runId, levelOutputDir, requiredLods);
            if (sentPlan) {
                runState.sentChunkPlan = true;
            }
        }

        const entries = await safeReadDir(levelOutputDir);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const match = chunkDirNameRe.exec(entry.name);
            if (!match) continue;

            const lod = Number(match[1]);
            if (!required.has(lod)) continue;
            if (sent.has(entry.name)) continue;

            const metaPath = path.join(levelOutputDir, entry.name, 'meta.json');
            try {
                await access(metaPath);
                const metaStat = await stat(metaPath);
                if (!metaStat.isFile() || metaStat.size <= 2) continue;

                if (!startedLods.has(lod)) {
                    startedLods.add(lod);
                    runState.currentLod = lod;
                    sseBroadcast('level-start', {
                        runId: runState.runId,
                        lod,
                        phase: 2
                    });
                }

                sent.add(entry.name);
                emitChunkReady(runState.runId, lod, entry.name);
            } catch {
                // not ready
            }
        }
    }, 700);

    return () => clearInterval(timer);
};

const emitFinalChunks = async (runState, levelOutputDir, requiredLods) => {
    const required = new Set(requiredLods.map(Number));
    const entries = await safeReadDir(levelOutputDir);

    const chunkEntries = entries
        .filter((entry) => entry.isDirectory() && chunkDirNameRe.test(entry.name))
        .map((entry) => {
            const match = chunkDirNameRe.exec(entry.name);
            return { entry, lod: Number(match[1]), index: Number(match[2]) };
        })
        .filter((item) => required.has(item.lod))
        .sort((a, b) => (b.lod - a.lod) || (a.index - b.index));

    for (const { entry, lod } of chunkEntries) {
        const metaPath = path.join(levelOutputDir, entry.name, 'meta.json');
        try {
            await access(metaPath);
            if (!runState.startedLods.has(lod)) {
                runState.startedLods.add(lod);
                runState.currentLod = lod;
                sseBroadcast('level-start', {
                    runId: runState.runId,
                    lod,
                    phase: 2
                });
            }
            emitChunkReady(runState.runId, lod, entry.name);
        } catch {
            // ignore
        }
    }
};

/**
 * Map child process step progress into overall [base, base+span] percent range.
 */
const streamLines = (stream, runState, type) => {
    let buffer = '';
    stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            let overallPercent = null;
            let levelPercent = null;
            let chunkName = runState.currentChunkName ?? null;
            let chunkPercent = null;

            const chunkWriteMatch = line.match(/writing\s+.+[\\/](\d+_\d+)[\\/]meta\.json/i);
            if (chunkWriteMatch) {
                const candidate = chunkWriteMatch[1];
                const match = chunkDirNameRe.exec(candidate);
                if (match) {
                    const lod = Number(match[1]);
                    runState.currentChunkName = candidate;
                    chunkName = candidate;
                    runState.currentLod = lod;

                    if (!runState.startedLods.has(lod)) {
                        runState.startedLods.add(lod);
                        sseBroadcast('level-start', {
                            runId: runState.runId,
                            lod,
                            phase: 2
                        });
                    }

                    sseBroadcast('chunk-start', {
                        runId: runState.runId,
                        lod,
                        chunkName: candidate
                    });
                }
            }

            const loadedMatch = line.match(/Total gaussians loaded:\s*([\d,]+)/i);
            if (loadedMatch) {
                const n = Number(loadedMatch[1].replace(/,/g, ''));
                if (Number.isFinite(n)) runState.originalCount = n;
            }
            const reduceMatch = line.match(/simplifyGaussians:\s*reducing\s+([\d,]+)\s*→\s*([\d,]+)/i);
            if (reduceMatch) {
                const from = Number(reduceMatch[1].replace(/,/g, ''));
                const to = Number(reduceMatch[2].replace(/,/g, ''));
                if (Number.isFinite(from)) runState.originalCount = from;
                if (Number.isFinite(to)) runState.compressedCount = to;
            }
            const passDoneMatch = line.match(/simplifyGaussians:\s*pass done\s*→\s*([\d,]+)/i);
            if (passDoneMatch) {
                const n = Number(passDoneMatch[1].replace(/,/g, ''));
                if (Number.isFinite(n)) runState.compressedCount = n;
            }

            const stepMatch = line.match(/\[(\d+)\/(\d+)\]/);
            if (stepMatch) {
                const step = Number(stepMatch[1]);
                const total = Number(stepMatch[2]);
                if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
                    const progress = Math.max(0, Math.min(1, step / total));
                    levelPercent = progress * 100;
                    if (chunkName) chunkPercent = levelPercent;

                    const base = runState.progressBase ?? 0;
                    const span = runState.progressSpan ?? 100;
                    const mapped = base + progress * span;
                    runState.lastPercent = Math.max(runState.lastPercent ?? 0, mapped);
                    overallPercent = runState.lastPercent;
                }
            } else {
                const percentMatch = line.match(/(\d+)%/);
                if (percentMatch) {
                    const local = Number(percentMatch[1]);
                    const base = runState.progressBase ?? 0;
                    const span = runState.progressSpan ?? 100;
                    const mapped = base + (local / 100) * span;
                    runState.lastPercent = Math.max(runState.lastPercent ?? 0, mapped);
                    overallPercent = runState.lastPercent;
                }
            }

            sseBroadcast('progress', {
                runId: runState.runId,
                type,
                line,
                percent: overallPercent,
                levelPercent,
                chunkName,
                chunkPercent,
                lod: runState.currentLod,
                phase: runState.phase
            });
        }
    });
};

const stopActiveRun = (reason = 'stopped') => {
    if (!activeRun) return false;
    const stopped = activeRun;
    activeRun.cancelled = true;
    if (activeRun.child && !activeRun.child.killed) {
        activeRun.child.kill();
    }
    sseBroadcast('run-stopped', { runId: activeRun.runId, reason });
    // Snapshot after disk reconcile (async); keep reference for restore
    getRunSnapshot(stopped).then((snap) => {
        lastRunSnapshot = snap;
    }).catch(() => {
        lastRunSnapshot = null;
    });
    activeRun = null;
    return true;
};

const cliPath = () => {
    if (!splatTransformRoot) {
        throw new Error(
            'splat-transform CLI not found. Set SPLAT_TRANSFORM_ROOT or install @playcanvas/splat-transform.'
        );
    }
    return path.join(splatTransformRoot, 'bin', 'cli.mjs');
};

const runCli = async (runState, args) => {
    if (runState.cancelled) {
        throw new Error('Run cancelled');
    }

    // Run CLI with cwd = splat-transform package root (native assets / wasm paths)
    const child = spawn(process.execPath, [cliPath(), ...args], {
        cwd: splatTransformRoot || repoRoot
    });
    runState.child = child;

    streamLines(child.stdout, runState, 'stdout');
    streamLines(child.stderr, runState, 'stderr');

    const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
    });

    runState.child = null;
    runState.currentChunkName = null;

    if (runState.cancelled) {
        throw new Error('Run cancelled');
    }
    if (exitCode !== 0) {
        throw new Error(`Command failed (exit ${exitCode}): splat-transform ${args.join(' ')}`);
    }
};

/**
 * Phase 1: sequentially produce intermediate simplified PLYs (one level at a time for stability).
 * L0 uses the original input and is not rewritten.
 */
const runPhase1Simplify = async (runState, levels, inputAbsPath, outputRootAbsPath, resume) => {
    const simplifyLevels = getSimplifyLevels(levels);
    const interDir = path.join(outputRootAbsPath, INTERMEDIATE_DIR);
    await mkdir(interDir, { recursive: true });

    runState.phase = 1;
    sseBroadcast('phase-start', {
        runId: runState.runId,
        phase: 1,
        title: '阶段 1 · 生成中间简化文件',
        total: simplifyLevels.length,
        intermediateDir: interDir
    });

    sseBroadcast('progress', {
        runId: runState.runId,
        type: 'server',
        line: `阶段 1：中间文件目录 → ${interDir}（L*.ply，每层简化完成后才出现）`,
        percent: runState.lastPercent ?? 0,
        phase: 1
    });

    if (simplifyLevels.length === 0) {
        sseBroadcast('progress', {
            runId: runState.runId,
            type: 'server',
            line: '无需简化层（仅 L0），跳过阶段 1。',
            percent: PHASE1_WEIGHT * 100,
            phase: 1
        });
        sseBroadcast('phase-complete', { runId: runState.runId, phase: 1 });
        runState.lastPercent = Math.max(runState.lastPercent ?? 0, PHASE1_WEIGHT * 100);
        return;
    }

    // Task rows for intermediate files
    for (const level of simplifyLevels) {
        sseBroadcast('intermediate-plan', {
            runId: runState.runId,
            lod: level.lod,
            taskName: `中间 L${level.lod}`,
            decimate: normalizeDecimateArg(level.decimate)
        });
    }

    // Announce L0 uses source
    const hasL0 = levels.some((l) => l.lod === 0);
    if (hasL0) {
        sseBroadcast('intermediate-ready', {
            runId: runState.runId,
            lod: 0,
            taskName: 'L0 原文件',
            isSource: true,
            skipPreview: true,
            resumed: true,
            path: inputAbsPath,
            previewUrl: null,
            sizeBytes: null
        });
    }

    for (let i = 0; i < simplifyLevels.length; i += 1) {
        if (runState.cancelled) throw new Error('Run cancelled');

        const level = simplifyLevels[i];
        const outPath = intermediateAbsPath(outputRootAbsPath, level.lod);
        const decimateArg = normalizeDecimateArg(level.decimate);
        const taskName = `中间 L${level.lod}`;
        const progressBase = (i / simplifyLevels.length) * PHASE1_WEIGHT * 100;
        const progressSpan = (1 / simplifyLevels.length) * PHASE1_WEIGHT * 100;
        runState.progressBase = progressBase;
        runState.progressSpan = progressSpan;
        runState.currentLod = level.lod;
        runState.currentLevelIndex = i;

        sseBroadcast('intermediate-start', {
            runId: runState.runId,
            lod: level.lod,
            taskName,
            decimate: decimateArg,
            index: i + 1,
            total: simplifyLevels.length
        });

        let resumed = false;
        if (resume && await isNonEmptyFile(outPath)) {
            resumed = true;
            sseBroadcast('progress', {
                runId: runState.runId,
                type: 'server',
                line: `检测到 ${taskName} 已存在，跳过简化。`,
                percent: progressBase + progressSpan,
                phase: 1,
                lod: level.lod
            });
        } else {
            sseBroadcast('progress', {
                runId: runState.runId,
                type: 'server',
                line: `阶段 1 [${i + 1}/${simplifyLevels.length}] 简化 L${level.lod}（保留 ${decimateArg}）…`,
                percent: progressBase,
                phase: 1,
                lod: level.lod
            });

            sseBroadcast('progress', {
                runId: runState.runId,
                type: 'server',
                line: `${taskName} 正在简化（-F ${decimateArg}）。近邻搜索最耗时；完成后写入：${outPath}`,
                percent: progressBase,
                phase: 1,
                lod: level.lod
            });
            await runCli(runState, ['-w', inputAbsPath, '-F', decimateArg, outPath]);
        }

        const fileStat = await stat(outPath).catch(() => null);
        const sizeBytes = fileStat?.size ?? null;
        const skipPreview = !sizeBytes || sizeBytes > PREVIEW_MAX_BYTES;
        const previewUrl = makeOutUrl(runState.runId, INTERMEDIATE_DIR, intermediateFileName(level.lod));

        runState.lastPercent = Math.max(runState.lastPercent ?? 0, progressBase + progressSpan);

        sseBroadcast('intermediate-ready', {
            runId: runState.runId,
            lod: level.lod,
            taskName,
            isSource: false,
            skipPreview,
            resumed,
            path: outPath,
            previewUrl,
            sizeBytes,
            format: 'ply'
        });

        sseBroadcast('progress', {
            runId: runState.runId,
            type: 'server',
            line: skipPreview
                ? `${taskName} 已写入 ${outPath}（${formatBytes(sizeBytes)}，过大跳过预览）`
                : `${taskName} 已写入 ${outPath}（${formatBytes(sizeBytes)}），可预览`,
            percent: runState.lastPercent,
            phase: 1,
            lod: level.lod
        });
    }

    runState.lastPercent = Math.max(runState.lastPercent ?? 0, PHASE1_WEIGHT * 100);
    sseBroadcast('phase-complete', {
        runId: runState.runId,
        phase: 1,
        percent: runState.lastPercent
    });
};

const formatBytes = (n) => {
    if (n == null || !Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/**
 * Phase 2: compose hierarchical lod-meta from source (L0) + intermediate PLYs.
 */
const runPhase2Compose = async (runState, levels, inputAbsPath, outputRootAbsPath, chunkCountK, chunkExtent) => {
    const requiredLods = levels.map((item) => item.lod);
    const sorted = [...levels].sort((a, b) => b.lod - a.lod);
    const outputMetaPath = path.join(outputRootAbsPath, 'lod-meta.json');

    runState.phase = 2;
    runState.startedLods = new Set();
    runState.sentChunkPlan = false;
    runState.currentLod = null;
    runState.progressBase = PHASE1_WEIGHT * 100;
    runState.progressSpan = PHASE2_WEIGHT * 100;

    sseBroadcast('phase-start', {
        runId: runState.runId,
        phase: 2,
        title: '阶段 2 · 合成 lod-meta 与分块',
        total: requiredLods.length
    });

    // Verify intermediates exist before compose
    for (const level of getSimplifyLevels(levels)) {
        const p = intermediateAbsPath(outputRootAbsPath, level.lod);
        if (!(await isNonEmptyFile(p))) {
            throw new Error(`缺少中间文件: ${p}`);
        }
    }

    const args = ['-w'];
    if (Number.isInteger(chunkCountK) && chunkCountK > 0) {
        args.push('-C', String(chunkCountK));
    }
    if (Number.isInteger(chunkExtent) && chunkExtent > 0) {
        args.push('-X', String(chunkExtent));
    }

    for (const level of sorted) {
        if (level.lod === 0 || !normalizeDecimateArg(level.decimate)) {
            args.push(inputAbsPath, '-l', String(level.lod));
        } else {
            args.push(intermediateAbsPath(outputRootAbsPath, level.lod), '-l', String(level.lod));
        }
    }
    args.push(outputMetaPath);

    sseBroadcast('progress', {
        runId: runState.runId,
        type: 'server',
        line: `阶段 2：合成多层 lod-meta（${sorted.length} 层输入）…`,
        percent: runState.progressBase,
        phase: 2
    });

    for (const lod of [...requiredLods].sort((a, b) => b - a)) {
        sseBroadcast('level-pending', {
            runId: runState.runId,
            lod,
            phase: 2
        });
    }

    const stopPoller = createChunkPoller(runState, outputRootAbsPath, requiredLods);

    try {
        await runCli(runState, args);
    } finally {
        stopPoller();
    }

    await emitChunkPlan(runState.runId, outputRootAbsPath, requiredLods);
    await emitFinalChunks(runState, outputRootAbsPath, requiredLods);

    for (const lod of requiredLods) {
        sseBroadcast('level-complete', { runId: runState.runId, lod, phase: 2 });
    }

    runState.lastPercent = 100;
    sseBroadcast('phase-complete', {
        runId: runState.runId,
        phase: 2,
        percent: 100
    });
};

const startLodRun = async (payload) => {
    if (activeRun) {
        throw new Error('已有任务在运行，请先点「停止」。');
    }

    const resume = payload.resume !== false;
    const levels = Array.isArray(payload.levels) ? payload.levels : DEFAULT_LEVELS;
    const normalizedLevels = levels
        .map((item) => ({
            lod: Number(item.lod),
            decimate: `${item.decimate ?? ''}`,
            chunkCountK: Number(item.chunkCountK ?? 512)
        }))
        .filter((item) => Number.isInteger(item.lod) && item.lod >= 0)
        .map((item) => ({
            ...item,
            chunkCountK: Number.isInteger(item.chunkCountK) && item.chunkCountK > 0 ? item.chunkCountK : 512
        }))
        .sort((a, b) => b.lod - a.lod);

    if (normalizedLevels.length === 0) {
        throw new Error('At least one valid LOD level is required.');
    }

    const chunkCountK = Number.isInteger(Number(payload.chunkCountK)) && Number(payload.chunkCountK) > 0
        ? Number(payload.chunkCountK)
        : normalizedLevels[0].chunkCountK;
    const chunkExtent = Number.isInteger(Number(payload.chunkExtent)) && Number(payload.chunkExtent) > 0
        ? Number(payload.chunkExtent)
        : null;

    const inputPath = `${payload.inputPath ?? ''}`.trim();
    const outputRoot = `${payload.outputRoot ?? 'output/live-lod'}`.trim();

    if (!inputPath) {
        throw new Error('请先选择输入文件。');
    }

    const inputAbsPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
    const outputRootAbsPath = path.isAbsolute(outputRoot) ? outputRoot : path.resolve(repoRoot, outputRoot);

    const inputStat = await stat(inputAbsPath).catch(() => null);
    if (!inputStat || !inputStat.isFile()) {
        throw new Error(`找不到输入文件：${inputAbsPath}。请确认路径存在，或把文件放到仓库 input/ 目录。`);
    }

    await mkdir(outputRootAbsPath, { recursive: true });

    const runState = {
        runId: `run-${Date.now()}`,
        mode: 'lod',
        child: null,
        cancelled: false,
        finished: false,
        totalLevels: normalizedLevels.length,
        currentLevelIndex: 0,
        lastPercent: 0,
        lastLine: '转换已开始…',
        currentLod: null,
        currentChunkName: null,
        outputRootAbsPath,
        inputAbsPath,
        inputPathDisplay: inputPath,
        outputRootDisplay: outputRoot,
        levels: normalizedLevels,
        chunkCountK,
        chunkExtent,
        startedLods: new Set(),
        sentChunkPlan: false,
        phase: 0,
        progressBase: 0,
        progressSpan: 100,
        tasks: new Map(),
        errorMessage: null
    };
    activeRun = runState;
    lastRunSnapshot = null;
    outputRoots.set(runState.runId, outputRootAbsPath);

    const requiredLods = normalizedLevels.map((item) => item.lod);

    sseBroadcast('run-start', {
        runId: runState.runId,
        mode: 'lod',
        inputPath: inputAbsPath,
        outputRoot,
        outputMetaUrl: makeOutUrl(runState.runId, 'lod-meta.json'),
        levels: normalizedLevels,
        chunkCountK,
        chunkExtent,
        pipeline: 'two-phase',
        intermediateDir: INTERMEDIATE_DIR
    });

    const pipeline = (async () => {
    try {
        // Fully complete → just load
        if (resume && await isLodOutputComplete(outputRootAbsPath, requiredLods)) {
            sseBroadcast('progress', {
                runId: runState.runId,
                type: 'server',
                line: '检测到完整多层 LOD 输出，跳过计算并直接加载。',
                percent: 100
            });
            await emitChunkPlan(runState.runId, outputRootAbsPath, requiredLods);
            await emitFinalChunks(runState, outputRootAbsPath, requiredLods);
            for (const lod of requiredLods) {
                sseBroadcast('level-complete', { runId: runState.runId, lod, phase: 2 });
            }
            runState.lastPercent = 100;
            sseBroadcast('run-complete', {
                runId: runState.runId,
                mode: 'lod',
                outputMetaUrl: makeOutUrl(runState.runId, 'lod-meta.json'),
                resumed: true
            });
            return;
        }

        if (!resume) {
            await clearIntermediates(outputRootAbsPath);
            await clearLodChunks(outputRootAbsPath);
        } else {
            // Re-compose only: keep intermediates, refresh final chunks
            await clearLodChunks(outputRootAbsPath);
        }

        // Phase 1
        await runPhase1Simplify(runState, normalizedLevels, inputAbsPath, outputRootAbsPath, resume);

        // Phase 2
        await runPhase2Compose(
            runState,
            normalizedLevels,
            inputAbsPath,
            outputRootAbsPath,
            chunkCountK,
            chunkExtent
        );

        sseBroadcast('run-complete', {
            runId: runState.runId,
            mode: 'lod',
            outputMetaUrl: makeOutUrl(runState.runId, 'lod-meta.json'),
            resumed: false
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Run cancelled') {
            return;
        }
        sseBroadcast('run-error', {
            runId: runState.runId,
            message
        });
        throw error;
    } finally {
        if (activeRun?.runId === runState.runId) {
            try {
                lastRunSnapshot = await getRunSnapshot(runState);
            } catch {
                lastRunSnapshot = null;
            }
            activeRun = null;
        }
    }
    })();
    pipeline.catch(() => {});
    return { runId: runState.runId, mode: 'lod' };
};

const readPlyVertexCount = async (filePath) => {
    try {
        const fh = await open(filePath, 'r');
        try {
            const buf = Buffer.alloc(8192);
            await fh.read(buf, 0, 8192, 0);
            const match = buf.toString('latin1').match(/element\s+vertex\s+(\d+)/i);
            const n = match ? Number(match[1]) : null;
            return Number.isFinite(n) ? n : null;
        } finally {
            await fh.close();
        }
    } catch {
        return null;
    }
};

const applyCompressPreviewUrls = async (runState) => {
    if (!runState?.outputRootAbsPath || !runState.runId) return;
    const origSog = path.join(runState.outputRootAbsPath, PREVIEW_ORIGINAL_SOG);
    const compSog = path.join(runState.outputRootAbsPath, PREVIEW_COMPRESSED_SOG);
    const hasOrigSog = await isNonEmptyFile(origSog);
    const hasCompSog = await isNonEmptyFile(compSog);

    if (hasOrigSog) {
        runState.originalPreviewUrl = makeOutUrl(runState.runId, PREVIEW_ORIGINAL_SOG);
        runState.skipOriginalPreview = false;
    } else if (!runState.originalPreviewUrl && runState.inputAbsPath) {
        runState.originalPreviewUrl = makeInputPreviewUrl(runState.inputAbsPath);
        runState.skipOriginalPreview = (runState.originalSizeBytes ?? 0) > PREVIEW_MAX_BYTES;
    }

    if (hasCompSog) {
        runState.compressedPreviewUrl = makeOutUrl(runState.runId, PREVIEW_COMPRESSED_SOG);
        runState.skipCompressedPreview = false;
    } else if (runState.compressedFileName) {
        runState.compressedPreviewUrl = makeOutUrl(runState.runId, runState.compressedFileName);
        runState.skipCompressedPreview = (runState.compressedSizeBytes ?? 0) > PREVIEW_MAX_BYTES;
    }
};

const writePreviewSog = async (runState, srcAbs, destAbs, label, base, span) => {
    runState.progressBase = base;
    runState.progressSpan = span;
    sseBroadcast('progress', {
        runId: runState.runId,
        type: 'server',
        line: `正在生成${label}三维预览（SOG，体积更小，便于浏览器加载）…`,
        percent: base,
        phase: 1
    });
    await runCli(runState, ['-w', srcAbs, destAbs]);
};

const PREVIEW_META_FILENAME = 'preview-meta.json';

const readPreviewMeta = async (metaPath) => readCompressMeta(metaPath);

const ensureCompressPreviewAssets = async (
    runState,
    inputAbsPath,
    compressedAbsPath,
    { forceCompressed = false } = {}
) => {
    const origSog = path.join(runState.outputRootAbsPath, PREVIEW_ORIGINAL_SOG);
    const compSog = path.join(runState.outputRootAbsPath, PREVIEW_COMPRESSED_SOG);
    const previewMetaPath = path.join(runState.outputRootAbsPath, PREVIEW_META_FILENAME);
    const previewMeta = await readPreviewMeta(previewMetaPath);
    const keepMatches = Number(previewMeta?.keepPercent) === Number(runState.keepPercent);
    const mustRebuildCompressed = forceCompressed || !keepMatches || !(await isNonEmptyFile(compSog));

    sseBroadcast('compress-plan', {
        runId: runState.runId,
        taskName: '对比预览',
        keepPercent: runState.keepPercent
    });
    trackTask(runState, '对比预览', { progress: 5, status: '正在计算' });

    try {
        if (mustRebuildCompressed) {
            await rm(compSog, { force: true }).catch(() => {});
            await writePreviewSog(runState, compressedAbsPath, compSog, '压缩后', 72, 13);
            await writeFile(previewMetaPath, JSON.stringify({
                keepPercent: runState.keepPercent,
                compressedFile: path.basename(compressedAbsPath),
                createdAt: new Date().toISOString()
            }, null, 2), 'utf-8');
        }
        if (!(await isNonEmptyFile(origSog))) {
            await writePreviewSog(runState, inputAbsPath, origSog, '原始', 85, 13);
        }
        trackTask(runState, '对比预览', { progress: 100, status: '已计算' }, { force: true });
    } catch (error) {
        trackTask(runState, '对比预览', { progress: 0, status: '计算失败' }, { force: true });
        sseBroadcast('progress', {
            runId: runState.runId,
            type: 'server',
            line: `预览资源生成失败，将尝试直接加载 PLY：${error instanceof Error ? error.message : error}`,
            percent: Math.max(runState.lastPercent ?? 0, 90),
            phase: 1
        });
    }

    await applyCompressPreviewUrls(runState);
};

const emitCompressComplete = (runState, { resumed = false } = {}) => {
    sseBroadcast('run-complete', {
        runId: runState.runId,
        mode: 'compress',
        resumed,
        keepPercent: runState.keepPercent,
        originalUrl: runState.originalPreviewUrl,
        compressedUrl: runState.compressedPreviewUrl,
        originalSizeBytes: runState.originalSizeBytes,
        compressedSizeBytes: runState.compressedSizeBytes,
        originalCount: runState.originalCount,
        compressedCount: runState.compressedCount,
        skipOriginalPreview: runState.skipOriginalPreview,
        skipCompressedPreview: runState.skipCompressedPreview,
        outputFile: runState.compressedFileName
    });
};

/**
 * Compress-only pipeline: decimate a single PLY (or other splat) to a keep-ratio output.
 * Does not generate LOD layers / lod-meta / chunks.
 */
const startCompressRun = async (payload) => {
    if (activeRun) {
        throw new Error('已有任务在运行，请先点「停止」。');
    }

    const resume = payload.resume !== false;
    const keepPercent = clampKeepPercent(payload.keepPercent);
    const decimateArg = `${keepPercent}%`;

    const inputPath = `${payload.inputPath ?? ''}`.trim();
    const outputRoot = `${payload.outputRoot ?? 'output/compressed'}`.trim();

    if (!inputPath) {
        throw new Error('请先选择输入文件。');
    }

    const inputAbsPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
    const outputRootAbsPath = path.isAbsolute(outputRoot) ? outputRoot : path.resolve(repoRoot, outputRoot);

    const inputStat = await stat(inputAbsPath).catch(() => null);
    if (!inputStat || !inputStat.isFile()) {
        throw new Error(`找不到输入文件：${inputAbsPath}。请确认路径存在，或把文件放到仓库 input/ 目录。`);
    }

    await mkdir(outputRootAbsPath, { recursive: true });

    const compressedFileName = COMPRESS_FILENAME;
    const outPath = path.join(outputRootAbsPath, compressedFileName);
    const metaPath = path.join(outputRootAbsPath, COMPRESS_META_FILENAME);
    const originalPreviewUrl = makeInputPreviewUrl(inputAbsPath);

    const runState = {
        runId: `run-${Date.now()}`,
        mode: 'compress',
        child: null,
        cancelled: false,
        finished: false,
        lastPercent: 0,
        lastLine: '压缩已开始…',
        currentLod: null,
        currentChunkName: null,
        outputRootAbsPath,
        inputAbsPath,
        inputPathDisplay: inputPath,
        outputRootDisplay: outputRoot,
        levels: [],
        keepPercent,
        compressedFileName,
        originalPreviewUrl,
        compressedPreviewUrl: null,
        originalSizeBytes: inputStat.size,
        compressedSizeBytes: null,
        originalCount: null,
        compressedCount: null,
        skipOriginalPreview: inputStat.size > PREVIEW_MAX_BYTES,
        skipCompressedPreview: false,
        startedLods: new Set(),
        sentChunkPlan: false,
        phase: 0,
        progressBase: 0,
        progressSpan: 100,
        tasks: new Map(),
        errorMessage: null
    };
    activeRun = runState;
    lastRunSnapshot = null;
    outputRoots.set(runState.runId, outputRootAbsPath);

    sseBroadcast('run-start', {
        runId: runState.runId,
        mode: 'compress',
        inputPath: inputAbsPath,
        outputRoot,
        keepPercent,
        pipeline: 'compress',
        originalUrl: originalPreviewUrl
    });

    const pipeline = (async () => {
    try {
        const existingMeta = await readCompressMeta(metaPath);
        const canResume = resume
            && await isNonEmptyFile(outPath)
            && Number(existingMeta?.keepPercent) === keepPercent;

        sseBroadcast('phase-start', {
            runId: runState.runId,
            phase: 1,
            title: `压缩模型 · 保留 ${decimateArg}`,
            total: 1
        });

        sseBroadcast('compress-plan', {
            runId: runState.runId,
            taskName: '原模型',
            keepPercent
        });
        sseBroadcast('compress-plan', {
            runId: runState.runId,
            taskName: '压缩输出',
            keepPercent
        });

        trackTask(runState, '原模型', { progress: 100, status: '已计算' }, { force: true });
        sseBroadcast('compress-original-ready', {
            runId: runState.runId,
            taskName: '原模型',
            previewUrl: originalPreviewUrl,
            sizeBytes: inputStat.size,
            skipPreview: runState.skipOriginalPreview
        });

        if (canResume) {
            const outStat = await stat(outPath);
            runState.compressedSizeBytes = outStat.size;
            runState.originalCount = existingMeta?.originalCount
                ?? await readPlyVertexCount(inputAbsPath)
                ?? runState.originalCount;
            runState.compressedCount = existingMeta?.compressedCount
                ?? await readPlyVertexCount(outPath)
                ?? runState.compressedCount;
            trackTask(runState, '压缩输出', { progress: 100, status: '已计算' }, { force: true });

            sseBroadcast('progress', {
                runId: runState.runId,
                type: 'server',
                line: `检测到已有保留 ${decimateArg} 的压缩结果，正在准备对比预览…`,
                percent: 70,
                phase: 1
            });

            await ensureCompressPreviewAssets(runState, inputAbsPath, outPath, { forceCompressed: false });
            runState.lastPercent = 100;

            sseBroadcast('compress-ready', {
                runId: runState.runId,
                resumed: true,
                keepPercent,
                originalUrl: runState.originalPreviewUrl,
                compressedUrl: runState.compressedPreviewUrl,
                originalSizeBytes: runState.originalSizeBytes,
                compressedSizeBytes: runState.compressedSizeBytes,
                originalCount: runState.originalCount,
                compressedCount: runState.compressedCount,
                skipOriginalPreview: runState.skipOriginalPreview,
                skipCompressedPreview: runState.skipCompressedPreview,
                path: outPath
            });

            sseBroadcast('phase-complete', {
                runId: runState.runId,
                phase: 1,
                percent: 100
            });
            emitCompressComplete(runState, { resumed: true });
            return;
        }

        trackTask(runState, '压缩输出', { progress: 5, status: '正在计算' });
        sseBroadcast('compress-start', {
            runId: runState.runId,
            taskName: '压缩输出',
            keepPercent,
            decimate: decimateArg
        });

        sseBroadcast('progress', {
            runId: runState.runId,
            type: 'server',
            line: `正在简化模型（保留 ${decimateArg}）→ ${outPath}`,
            percent: 2,
            phase: 1
        });

        runState.progressBase = 0;
        runState.progressSpan = 70;
        await rm(path.join(outputRootAbsPath, PREVIEW_COMPRESSED_SOG), { force: true }).catch(() => {});
        await rm(path.join(outputRootAbsPath, PREVIEW_META_FILENAME), { force: true }).catch(() => {});
        await runCli(runState, ['-w', inputAbsPath, '-F', decimateArg, outPath]);

        const outStat = await stat(outPath).catch(() => null);
        if (!outStat?.isFile() || outStat.size <= 64) {
            throw new Error(`压缩输出写入失败: ${outPath}`);
        }

        runState.compressedSizeBytes = outStat.size;
        runState.originalCount = await readPlyVertexCount(inputAbsPath) ?? runState.originalCount;
        runState.compressedCount = await readPlyVertexCount(outPath) ?? runState.compressedCount;
        runState.lastPercent = Math.max(runState.lastPercent ?? 0, 70);

        await writeFile(metaPath, JSON.stringify({
            mode: 'compress',
            keepPercent,
            inputPath: inputAbsPath,
            outputFile: compressedFileName,
            originalSizeBytes: runState.originalSizeBytes,
            compressedSizeBytes: runState.compressedSizeBytes,
            originalCount: runState.originalCount,
            compressedCount: runState.compressedCount,
            createdAt: new Date().toISOString()
        }, null, 2), 'utf-8');

        trackTask(runState, '压缩输出', { progress: 100, status: '已计算' }, { force: true });

        sseBroadcast('progress', {
            runId: runState.runId,
            type: 'server',
            line: `压缩完成：${formatBytes(runState.originalSizeBytes)} → ${formatBytes(runState.compressedSizeBytes)}（保留 ${decimateArg}）。接着生成对比预览…`,
            percent: 70,
            phase: 1
        });

        await ensureCompressPreviewAssets(runState, inputAbsPath, outPath, { forceCompressed: true });
        runState.lastPercent = 100;

        sseBroadcast('compress-ready', {
            runId: runState.runId,
            resumed: false,
            keepPercent,
            originalUrl: runState.originalPreviewUrl,
            compressedUrl: runState.compressedPreviewUrl,
            originalSizeBytes: runState.originalSizeBytes,
            compressedSizeBytes: runState.compressedSizeBytes,
            originalCount: runState.originalCount,
            compressedCount: runState.compressedCount,
            skipOriginalPreview: runState.skipOriginalPreview,
            skipCompressedPreview: runState.skipCompressedPreview,
            path: outPath
        });

        sseBroadcast('progress', {
            runId: runState.runId,
            type: 'server',
            line: `压缩完成：${formatBytes(runState.originalSizeBytes)} → ${formatBytes(runState.compressedSizeBytes)}（保留 ${decimateArg}）`,
            percent: 100,
            phase: 1
        });

        sseBroadcast('phase-complete', {
            runId: runState.runId,
            phase: 1,
            percent: 100
        });
        emitCompressComplete(runState, { resumed: false });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Run cancelled') {
            return;
        }
        sseBroadcast('run-error', {
            runId: runState.runId,
            message
        });
        throw error;
    } finally {
        if (activeRun?.runId === runState.runId) {
            try {
                lastRunSnapshot = await getRunSnapshot(runState);
            } catch {
                lastRunSnapshot = null;
            }
            activeRun = null;
        }
    }
    })();
    pipeline.catch(() => {});
    return { runId: runState.runId, mode: 'compress' };
};

const startRun = async (payload) => {
    const mode = `${payload?.mode ?? 'lod'}`.trim() === 'compress' ? 'compress' : 'lod';
    if (mode === 'compress') {
        return startCompressRun(payload);
    }
    return startLodRun(payload);
};

const parseBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf-8') || '{}';
    return JSON.parse(text);
};

const runPowerShellPick = (script) => {
    return new Promise((resolve, reject) => {
        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encodedScript], {
            cwd: repoRoot
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const details = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ');
                reject(new Error(details || `PowerShell exited with code ${code}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
};

const pickInputFile = async () => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Filter = "Splat Files (*.sog;*.ply;*.compressed.ply;*.ksplat;*.splat;*.spz)|*.sog;*.ply;*.compressed.ply;*.ksplat;*.splat;*.spz|All Files (*.*)|*.*"
$dlg.Multiselect = $false
$ok = $dlg.ShowDialog()
if ($ok -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dlg.FileName) }
`;
    return runPowerShellPick(script);
};

const pickOutputFolder = async () => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.ShowNewFolderButton = $true
$ok = $dlg.ShowDialog()
if ($ok -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dlg.SelectedPath) }
`;
    return runPowerShellPick(script);
};

const serveFile = async (res, filePath) => {
    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            sendJson(res, 404, { error: 'Not found' });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
            'Content-Length': fileStat.size,
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        createReadStream(filePath).pipe(res);
    } catch {
        sendJson(res, 404, { error: 'Not found' });
    }
};

const contentDisposition = (downloadName) => {
    const ascii = `${downloadName}`.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii || 'download'}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
};

const serveDownload = async (res, filePath, downloadName) => {
    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            sendJson(res, 404, { error: 'File not found' });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
            'Content-Length': fileStat.size,
            'Content-Disposition': contentDisposition(downloadName || path.basename(filePath)),
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        createReadStream(filePath).pipe(res);
    } catch {
        sendJson(res, 404, { error: 'File not found' });
    }
};

const resolveDownloadOutputRoot = (outputRoot) => {
    const text = `${outputRoot ?? ''}`.trim();
    if (!text) {
        throw new Error('请填写输出目录。');
    }
    const abs = path.isAbsolute(text) ? path.resolve(text) : path.resolve(repoRoot, text);
    if (!isPathInside(abs, repoRoot)) {
        throw new Error('只能下载工具仓库内的输出文件。');
    }
    return abs;
};

const pickPrimaryOutputFile = (names) => {
    const set = new Set(names.map((n) => n.toLowerCase()));
    const preferred = ['compressed.ply', 'lod-meta.json'];
    for (const name of preferred) {
        if (set.has(name)) return names.find((n) => n.toLowerCase() === name);
    }
    const ply = names.find((n) => n.toLowerCase().endsWith('.ply') && !n.toLowerCase().includes('preview'));
    if (ply) return ply;
    return names[0] || null;
};

const makeServedOutputBase = (absDir) => {
    try {
        const rel = path.relative(repoRoot, absDir).replaceAll('\\', '/');
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            return `/repo/${rel.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
        }
    } catch {
        // fall through
    }
    const token = `open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    outputRoots.set(token, absDir);
    return `/out/${encodeURIComponent(token)}`;
};

const inspectOutputFolder = async (abs) => {
    const files = await listOutputFiles(abs);
    const names = files.map((item) => item.name);
    const lower = new Set(names.map((name) => name.toLowerCase()));
    const hasLod = lower.has('lod-meta.json');
    const hasCompress = lower.has('compressed.ply') || lower.has('compress-meta.json');
    const kind = hasLod ? 'lod' : hasCompress ? 'compress' : null;
    let lodLevels = null;
    let keepPercent = null;
    let originalCount = null;
    let compressedCount = null;
    let originalSizeBytes = null;
    let compressedSizeBytes = null;

    if (hasLod) {
        try {
            const parsed = JSON.parse(await readFile(path.join(abs, 'lod-meta.json'), 'utf-8'));
            lodLevels = Number(parsed?.lodLevels);
            if (!Number.isFinite(lodLevels) || lodLevels <= 0) lodLevels = null;
        } catch {
            lodLevels = null;
        }
    }

    if (hasCompress) {
        const meta = await readCompressMeta(path.join(abs, COMPRESS_META_FILENAME));
        keepPercent = meta?.keepPercent ?? null;
        originalCount = meta?.originalCount ?? null;
        compressedCount = meta?.compressedCount ?? null;
        originalSizeBytes = meta?.originalSizeBytes ?? null;
        compressedSizeBytes = meta?.compressedSizeBytes ?? files.find((f) => f.name.toLowerCase() === 'compressed.ply')?.sizeBytes ?? null;
    }

    return {
        files,
        kind,
        canPreview: Boolean(kind),
        hasLod,
        hasCompress,
        lodLevels,
        keepPercent,
        originalCount,
        compressedCount,
        originalSizeBytes,
        compressedSizeBytes
    };
};

const listOutputFiles = async (outputRootAbsPath) => {
    const entries = await safeReadDir(outputRootAbsPath);
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(outputRootAbsPath, entry.name);
        const st = await stat(full).catch(() => null);
        if (!st?.isFile()) continue;
        files.push({
            name: entry.name,
            sizeBytes: st.size
        });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    return files;
};

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && reqUrl.pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });
        res.write('retry: 1000\n\n');
        sseClients.add(res);

        // Immediately restore in-flight (or last) run after page refresh
        try {
            const snapshot = activeRun
                ? await getRunSnapshot(activeRun)
                : lastRunSnapshot;
            if (snapshot) {
                // Re-reconcile last snapshot too (disk may have more complete files)
                if (!activeRun && lastRunSnapshot?.runId) {
                    // lastRunSnapshot already reconciled at finish; send as-is
                }
                sseSend(res, 'run-snapshot', snapshot);
            }
        } catch {
            // ignore restore errors on connect
        }

        req.on('close', () => {
            sseClients.delete(res);
        });
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/status') {
        try {
            const snapshot = activeRun
                ? await getRunSnapshot(activeRun)
                : lastRunSnapshot;
            sendJson(res, 200, {
                active: Boolean(activeRun && !activeRun.finished),
                run: snapshot
            });
        } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/defaults') {
        sendJson(res, 200, {
            inputPath: 'input/example.ply',
            outputRoot: 'output/example',
            levels: DEFAULT_LEVELS,
            chunkCountK: 512,
            chunkExtent: 16,
            pipeline: 'two-phase',
            mode: 'lod',
            keepPercent: DEFAULT_KEEP_PERCENT,
            splatTransformRoot
        });
        return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/start') {
        try {
            const body = await parseBody(req);
            const launched = await startRun(body);
            sendJson(res, 200, { ok: true, runId: launched.runId, mode: launched.mode });
        } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/stop') {
        const stopped = stopActiveRun('user-request');
        sendJson(res, 200, { ok: true, stopped });
        return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/resolve-input') {
        try {
            const body = await parseBody(req);
            const fileName = path.basename(`${body.fileName ?? body.name ?? ''}`.trim());
            const hintPath = normalizeDroppedPath(`${body.path ?? ''}`.trim());

            if (hintPath) {
                const abs = path.isAbsolute(hintPath) ? hintPath : path.resolve(repoRoot, hintPath);
                const st = await stat(abs).catch(() => null);
                if (st?.isFile()) {
                    const rel = path.relative(repoRoot, abs).replaceAll('\\', '/');
                    const value = (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : abs;
                    sendJson(res, 200, { ok: true, found: true, value, absPath: abs });
                    return;
                }
            }

            if (!fileName) {
                sendJson(res, 400, { error: 'fileName is required' });
                return;
            }

            // Prefer input/ under repo, then shallow search of input subdirs
            const candidates = [
                path.join(repoRoot, 'input', fileName),
                path.join(repoRoot, fileName)
            ];
            const inputDir = path.join(repoRoot, 'input');
            const entries = await safeReadDir(inputDir);
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    candidates.push(path.join(inputDir, entry.name, fileName));
                } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                    candidates.push(path.join(inputDir, entry.name));
                }
            }

            for (const abs of candidates) {
                const st = await stat(abs).catch(() => null);
                if (st?.isFile()) {
                    const rel = path.relative(repoRoot, abs).replaceAll('\\', '/');
                    sendJson(res, 200, {
                        ok: true,
                        found: true,
                        value: rel,
                        absPath: abs
                    });
                    return;
                }
            }

            sendJson(res, 200, {
                ok: true,
                found: false,
                value: '',
                message: `未找到 ${fileName}。请使用浏览按钮选择真实路径，或把文件拖入窗口以导入。`
            });
        } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/upload-input') {
        try {
            const rawName = reqUrl.searchParams.get('name')
                || `${req.headers['x-file-name'] ?? ''}`;
            const fileName = sanitizeUploadFileName(decodeURIComponent(rawName));
            if (!isAcceptedInputFileName(fileName)) {
                sendJson(res, 400, { error: `不支持的文件类型：${fileName}` });
                return;
            }

            const inputDir = path.join(repoRoot, 'input');
            await mkdir(inputDir, { recursive: true });
            const destAbs = path.join(inputDir, fileName);
            if (!isPathInside(destAbs, inputDir)) {
                sendJson(res, 400, { error: 'Invalid upload path' });
                return;
            }

            await pipeline(req, createWriteStream(destAbs));
            const st = await stat(destAbs).catch(() => null);
            if (!st?.isFile() || st.size <= 0) {
                sendJson(res, 500, { error: '文件导入失败，未写入内容。' });
                return;
            }

            sendJson(res, 200, {
                ok: true,
                value: `input/${fileName}`.replaceAll('\\', '/'),
                absPath: destAbs,
                sizeBytes: st.size
            });
        } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/output-files') {
        try {
            const outputRoot = `${reqUrl.searchParams.get('root') ?? ''}`.trim();
            const abs = resolveDownloadOutputRoot(outputRoot);
            const dirStat = await stat(abs).catch(() => null);
            if (!dirStat?.isDirectory()) {
                sendJson(res, 200, { ok: true, exists: false, files: [], primary: null, absPath: abs });
                return;
            }
            const inspected = await inspectOutputFolder(abs);
            sendJson(res, 200, {
                ok: true,
                exists: true,
                absPath: abs,
                files: inspected.files,
                primary: pickPrimaryOutputFile(inspected.files.map((f) => f.name)),
                kind: inspected.kind,
                canPreview: inspected.canPreview,
                lodLevels: inspected.lodLevels,
                keepPercent: inspected.keepPercent
            });
        } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/open-output') {
        try {
            const body = await parseBody(req);
            const outputRoot = `${body.outputRoot ?? ''}`.trim();
            const abs = resolveDownloadOutputRoot(outputRoot);
            const dirStat = await stat(abs).catch(() => null);
            if (!dirStat?.isDirectory()) {
                sendJson(res, 404, { error: `输出目录不存在：${abs}` });
                return;
            }
            const inspected = await inspectOutputFolder(abs);
            if (!inspected.kind) {
                sendJson(res, 400, { error: '该目录没有可预览的结果（需要 lod-meta.json 或 compressed.ply）。' });
                return;
            }

            const base = makeServedOutputBase(abs);
            if (inspected.kind === 'lod') {
                const lodCount = inspected.lodLevels || 1;
                sendJson(res, 200, {
                    ok: true,
                    kind: 'lod',
                    outputRoot,
                    absPath: abs,
                    lodLevels: lodCount,
                    levels: Array.from({ length: lodCount }, (_, i) => ({
                        lod: lodCount - 1 - i,
                        decimate: '',
                        chunkCountK: 512
                    })),
                    outputMetaUrl: `${base}/lod-meta.json`
                });
                return;
            }

            const hasOrigSog = inspected.files.some((f) => f.name === PREVIEW_ORIGINAL_SOG);
            const hasCompSog = inspected.files.some((f) => f.name === PREVIEW_COMPRESSED_SOG);
            const compressedSize = inspected.files.find((f) => f.name.toLowerCase() === 'compressed.ply')?.sizeBytes ?? inspected.compressedSizeBytes;
            sendJson(res, 200, {
                ok: true,
                kind: 'compress',
                outputRoot,
                absPath: abs,
                keepPercent: inspected.keepPercent,
                originalCount: inspected.originalCount,
                compressedCount: inspected.compressedCount,
                originalSizeBytes: inspected.originalSizeBytes,
                compressedSizeBytes: compressedSize,
                originalUrl: hasOrigSog ? `${base}/${PREVIEW_ORIGINAL_SOG}` : null,
                compressedUrl: hasCompSog
                    ? `${base}/${PREVIEW_COMPRESSED_SOG}`
                    : `${base}/${COMPRESS_FILENAME}`,
                skipOriginalPreview: !hasOrigSog,
                skipCompressedPreview: !hasCompSog && (compressedSize ?? 0) > PREVIEW_MAX_BYTES
            });
        } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/download-output') {
        try {
            const outputRoot = `${reqUrl.searchParams.get('root') ?? ''}`.trim();
            const requested = path.basename(`${reqUrl.searchParams.get('name') ?? ''}`.trim());
            const abs = resolveDownloadOutputRoot(outputRoot);
            const dirStat = await stat(abs).catch(() => null);
            if (!dirStat?.isDirectory()) {
                sendJson(res, 404, { error: `输出目录不存在：${abs}` });
                return;
            }
            const files = await listOutputFiles(abs);
            const names = files.map((f) => f.name);
            const fileName = requested || pickPrimaryOutputFile(names);
            if (!fileName || !names.includes(fileName)) {
                sendJson(res, 404, { error: '输出目录中还没有可下载的结果文件。' });
                return;
            }
            const target = path.resolve(abs, fileName);
            if (!isPathInside(target, abs)) {
                sendJson(res, 400, { error: 'Invalid file path' });
                return;
            }
            const folder = path.basename(abs) || 'output';
            const downloadName = fileName.toLowerCase() === 'compressed.ply'
                ? `${folder}.ply`
                : `${folder}-${fileName}`;
            await serveDownload(res, target, downloadName);
        } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/pick-path') {
        try {
            const body = await parseBody(req);
            const kind = `${body.kind ?? ''}`.trim();
            if (!['input', 'output'].includes(kind)) {
                sendJson(res, 400, { error: 'Invalid kind, expected input or output.' });
                return;
            }

            const picked = kind === 'input' ? await pickInputFile() : await pickOutputFolder();
            if (!picked) {
                sendJson(res, 200, { ok: true, cancelled: true });
                return;
            }

            let value = picked;
            if (kind === 'output') {
                try {
                    const normalized = normalizeRelPath(picked);
                    value = normalized.rel || '.';
                } catch {
                    value = picked;
                }
            } else {
                value = picked;
            }

            sendJson(res, 200, { ok: true, cancelled: false, value });
        } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/out/')) {
        const parts = reqUrl.pathname.slice('/out/'.length).split('/').filter(Boolean);
        if (parts.length < 1) {
            sendJson(res, 400, { error: 'Invalid output path' });
            return;
        }
        const token = decodeURIComponent(parts[0]);
        const root = outputRoots.get(token);
        if (!root) {
            sendJson(res, 404, { error: 'Unknown output token. Start a conversion run first.' });
            return;
        }
        const relParts = parts.slice(1).map((part) => decodeURIComponent(part));
        const target = path.resolve(root, ...relParts);
        if (!isPathInside(target, root)) {
            sendJson(res, 400, { error: 'Path escapes output root' });
            return;
        }
        await serveFile(res, target);
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/repo/')) {
        const rel = decodeURI(reqUrl.pathname.slice('/repo/'.length));
        try {
            const normalized = normalizeRelPath(rel);
            await serveFile(res, normalized.resolved);
        } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/file/')) {
        const id = reqUrl.pathname.slice('/file/'.length);
        const filePath = fileRegistry.get(id);
        if (!filePath) {
            sendJson(res, 404, { error: 'File token not found' });
            return;
        }
        await serveFile(res, filePath);
        return;
    }

    if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html')) {
        await serveFile(res, path.join(publicDir, 'index.html'));
        return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/app.js') {
        await serveFile(res, path.join(publicDir, 'app.js'));
        return;
    }

    sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
    console.log(`LOD online tool running at http://localhost:${port}`);
    console.log(`  workspace : ${repoRoot}`);
    console.log(`  splat-cli : ${splatTransformRoot || '(not found — set SPLAT_TRANSFORM_ROOT)'}`);
});
