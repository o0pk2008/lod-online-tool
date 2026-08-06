import {
    Application,
    Asset,
    AssetListLoader,
    Color,
    Entity,
    FILLMODE_NONE,
    RESOLUTION_AUTO,
    Vec3
} from 'playcanvas';

const inputPathEl = document.getElementById('inputPath');
const outputRootEl = document.getElementById('outputRoot');
const levelFormEl = document.getElementById('levelForm');
const settingsPanelEl = document.getElementById('settingsPanel');
const lodCountEl = document.getElementById('lodCount');
const chunkCountKEl = document.getElementById('chunkCountK');
const startBtn = document.getElementById('startBtn');
const startBtnLabel = document.getElementById('startBtnLabel');
const startBtnSpinner = document.getElementById('startBtnSpinner');
const stopBtn = document.getElementById('stopBtn');
const pickInputBtn = document.getElementById('pickInputBtn');
const pickOutputBtn = document.getElementById('pickOutputBtn');
const inputDropZone = document.getElementById('inputDropZone');
const inputFileHidden = document.getElementById('inputFileHidden');
const inputDropHint = document.getElementById('inputDropHint');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const currentLodEl = document.getElementById('currentLod');
const chunkCountEl = document.getElementById('chunkCount');
const taskTableBodyEl = document.getElementById('taskTableBody');
const taskSummaryEl = document.getElementById('taskSummary');
const viewModeLabelEl = document.getElementById('viewModeLabel');
const statusDotEl = document.getElementById('statusDot');
const statusPhaseEl = document.getElementById('statusPhase');
const stepBarEl = document.getElementById('stepBar');
const resetCameraBtn = document.getElementById('resetCameraBtn');
const helpBtn = document.getElementById('helpBtn');
const helpModal = document.getElementById('helpModal');
const helpCloseBtn = document.getElementById('helpCloseBtn');
const helpOkBtn = document.getElementById('helpOkBtn');
const canvas = document.getElementById('pcanvas');

const CONFIG_STORAGE_KEY = 'lod-online-tool:config:v1';
const INPUT_EXTS = ['.ply', '.sog', '.splat', '.spz', '.ksplat'];

/** Last auto-suggested output path; used so we only overwrite output when still "auto" */
let lastSuggestedOutput = '';

let activeRunId = null;
let currentLod = null;
let loadedChunkCount = 0;
let currentChunkName = null;
let finalLodMetaUrl = null;
let isRestoringSnapshot = false;
const chunkTasks = new Map();

const loadedChunks = new Set();
const loadingChunks = new Set();
const chunkEntities = [];
let levelState = [];
const levelChunkQueue = new Map();
const pendingChunkLoads = new Map();
let isChunkLoadPumping = false;
/** When true, viewer shows hierarchical lod-meta instead of per-chunk SOGs */
let showingFinalLod = false;
/** 0 idle · 1 simplify intermediates · 2 compose lod-meta · 3 final */
let pipelinePhase = 0;
const PREVIEW_MODE = {
    none: 'none',
    intermediate: 'intermediate',
    chunks: 'chunks',
    final: 'final'
};
let previewMode = PREVIEW_MODE.none;

const app = new Application(canvas, {
    graphicsDeviceOptions: {
        antialias: false
    }
});
app.setCanvasFillMode(FILLMODE_NONE);
app.setCanvasResolution(RESOLUTION_AUTO);
app.start();

const resizeCanvasToContainer = () => {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    app.resizeCanvas(width, height);
};

const resizeObserver = new ResizeObserver(() => {
    resizeCanvasToContainer();
});
resizeObserver.observe(canvas);
window.addEventListener('resize', resizeCanvasToContainer);
resizeCanvasToContainer();

// Large outdoor maps need a far clip well beyond default (~1000), otherwise
// zooming out makes the whole splat vanish (far-plane clipping).
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 500000;
const ORBIT_MIN_DISTANCE = 0.5;
const ORBIT_MAX_DISTANCE = 200000;

const camera = new Entity('Camera');
camera.setPosition(0, 0, 3);
camera.addComponent('camera', {
    clearColor: [0.09, 0.1, 0.12, 1],
    nearClip: CAMERA_NEAR,
    farClip: CAMERA_FAR
});
app.root.addChild(camera);

const target = new Vec3(0, 0, 0);
camera.lookAt(target);

let distance = camera.getPosition().distance(target);
let yaw = 0;
let pitch = 0;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const syncOrbitFromCamera = () => {
    const v = camera.getPosition().clone().sub(target);
    const d = v.length();
    if (d < 1e-6) return;
    yaw = Math.atan2(v.x, v.z);
    pitch = Math.asin(clamp(v.y / d, -1, 1));
};

const applyOrbit = () => {
    const cosPitch = Math.cos(pitch);
    camera.setPosition(
        target.x + distance * Math.sin(yaw) * cosPitch,
        target.y + distance * Math.sin(pitch),
        target.z + distance * Math.cos(yaw) * cosPitch
    );
    camera.lookAt(target);
};

/**
 * Keep near/far clip proportional to orbit distance so large scenes don't
 * clip when zoomed out, and depth precision stays usable when zoomed in.
 */
const syncCameraClipPlanes = () => {
    const cam = camera.camera;
    if (!cam) return;
    // near: small fraction of distance, clamped
    cam.nearClip = clamp(distance * 0.001, 0.01, 10);
    // far: comfortably beyond orbit radius and scene extent
    cam.farClip = Math.max(CAMERA_FAR, distance * 20);
};

syncOrbitFromCamera();
syncCameraClipPlanes();

const resetCameraHome = () => {
    target.set(0, 0, 0);
    distance = 3;
    yaw = 0;
    // default to top view (camera above +Y looking down to origin)
    pitch = Math.PI / 2 - 0.01;
    applyOrbit();
    syncCameraClipPlanes();
    camera.lookAt(0, 0, 0);
};

/**
 * Frame the camera on a loaded gsplat entity AABB when available.
 */
const frameEntityInView = (entity) => {
    try {
        const gsplat = entity?.gsplat;
        // Prefer custom AABB if engine exposes it
        const aabb = gsplat?.customAabb || gsplat?.aabb || entity?.render?.meshInstances?.[0]?.aabb;
        if (!aabb || !aabb.halfExtents) return false;

        const center = aabb.center;
        const he = aabb.halfExtents;
        const radius = Math.max(he.x, he.y, he.z, 1) * 2.2;
        target.set(center.x, center.y, center.z);
        distance = clamp(radius, ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE);
        applyOrbit();
        syncCameraClipPlanes();
        return true;
    } catch {
        return false;
    }
};

resetCameraHome();

const drawReferenceGrid = () => {
    const size = 20;
    const step = 1;
    const minor = new Color(0.25, 0.25, 0.28);
    const major = new Color(0.4, 0.4, 0.45);
    const axisX = new Color(0.95, 0.2, 0.2);
    const axisZ = new Color(0.25, 0.5, 1.0);

    for (let i = -size; i <= size; i += step) {
        const color = i % 5 === 0 ? major : minor;
        app.drawLine(new Vec3(-size, 0, i), new Vec3(size, 0, i), color, false);
        app.drawLine(new Vec3(i, 0, -size), new Vec3(i, 0, size), color, false);
    }

    // professional reference axes: X red, Z blue
    app.drawLine(new Vec3(-size, 0, 0), new Vec3(size, 0, 0), axisX, false);
    app.drawLine(new Vec3(0, 0, -size), new Vec3(0, 0, size), axisZ, false);
};

app.on('update', () => {
    drawReferenceGrid();
});

let isLeftDown = false;
let isRightDown = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) isLeftDown = true;
    if (e.button === 2) isRightDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
});
window.addEventListener('mouseup', (e) => {
    if (e.button === 0) isLeftDown = false;
    if (e.button === 2) isRightDown = false;
});
window.addEventListener('mousemove', (e) => {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isLeftDown) {
        yaw -= dx * 0.005;
        pitch = clamp(pitch + dy * 0.005, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        applyOrbit();
        syncCameraClipPlanes();
    } else if (isRightDown) {
        const canvasHeight = canvas.clientHeight || 1;
        const fovRad = (camera.camera.fov * Math.PI) / 180;
        const pixelsToWorld = (2 * distance * Math.tan(fovRad / 2)) / canvasHeight;
        const offset = camera.right.clone().mulScalar(-dx * pixelsToWorld)
            .add(camera.up.clone().mulScalar(dy * pixelsToWorld));
        offset.y = 0;
        target.add(offset);
        camera.setPosition(camera.getPosition().clone().add(offset));
        camera.lookAt(target);
    }
});
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    distance = clamp(distance * Math.exp(e.deltaY * 0.001), ORBIT_MIN_DISTANCE, ORBIT_MAX_DISTANCE);
    applyOrbit();
    syncCameraClipPlanes();
}, { passive: false });

const humanizeProgressLine = (line) => {
    const text = `${line ?? ''}`.trim();
    if (!text) return text;

    // Nested simplify sub-steps: [12/100] nearest neighbors 120000/1000000 (12%)
    const knn = text.match(/nearest neighbors\s+(\d+)\/(\d+)\s+\((\d+)%\)/i);
    if (knn) return `查找近邻点：${knn[1]}/${knn[2]}（${knn[3]}%）· 数据量大时此步最久`;

    const costs = text.match(/edge costs\s+(\d+)\/(\d+)\s+\((\d+)%\)/i);
    if (costs) return `计算合并代价：${costs[1]}/${costs[2]}（${costs[3]}%）`;

    const merges = text.match(/merging pairs\s+(\d+)\/(\d+)\s+\((\d+)%\)/i);
    if (merges) return `合并高斯点对：${merges[1]}/${merges[2]}（${merges[3]}%）`;

    if (/Building KD-tree/i.test(text)) return '构建空间索引（KD-tree）…';
    if (/Finding nearest neighbors/i.test(text)) {
        return '开始查找近邻（大数据可能很久，随后会显示 百分比 子进度）…';
    }
    if (/Computing edge costs/i.test(text)) return '开始计算边代价…';
    if (/Merging splats/i.test(text)) return '开始合并高斯…';
    if (/Finalizing/i.test(text)) return '本轮简化收尾…';

    const pass = text.match(/simplifyGaussians:\s*pass\s+(\d+)\s*[·.]\s*(\d+)\s*points?\s*\(target\s*(\d+)\)/i);
    if (pass) return `简化第 ${pass[1]} 轮：当前 ${pass[2]} 点 → 目标 ${pass[3]}`;

    const reduce = text.match(/simplifyGaussians:\s*reducing\s+(\d+)\s*→\s*(\d+)/i);
    if (reduce) return `开始简化：${reduce[1]} → ${reduce[2]} 个高斯（成对合并，较耗时）`;

    const passDone = text.match(/simplifyGaussians:\s*pass done\s*→\s*(\d+)/i);
    if (passDone) return `本轮简化完成，当前剩余 ${passDone[1]} 个高斯`;

    if (/writing\s+.+/i.test(text)) {
        const m = text.match(/(\d+_\d+)/);
        return m ? `正在写入分块 ${m[1]}…` : '正在写入分块资源…';
    }
    if (/reading\s+.+/i.test(text)) return '正在读取输入模型…';
    if (/simplifyGaussians|decimat|pairwise/i.test(text)) return text;
    if (/Total gaussians/i.test(text)) return text.replace(/Total gaussians loaded:/i, '已加载高斯数:');
    if (/done in/i.test(text)) return text.replace(/done in/i, '完成，耗时');
    if (/启动合并 LOD|合成多层|阶段 2/i.test(text)) return text.includes('阶段') ? text : '阶段 2：正在合成 lod-meta…';
    if (/阶段 1|简化 L|中间文件/i.test(text)) return text;
    if (/中间 L\d+ 已就绪/i.test(text)) return text;
    if (/检测到完整多层|跳过/i.test(text)) return text;
    if (text.length > 140) return `${text.slice(0, 120)}…`;
    return text;
};

const setStatusPhase = (phase, tone = 'idle') => {
    if (statusPhaseEl) statusPhaseEl.textContent = phase;
    if (!statusDotEl) return;
    const colors = {
        idle: '#1d6feb',
        run: '#0d74ce',
        ok: '#3f8500',
        warn: '#ab6400',
        err: '#cf2a2a'
    };
    statusDotEl.style.background = colors[tone] || colors.idle;
};

const setWorkflowStep = (step) => {
    if (!stepBarEl) return;
    const active = clamp(Number(step) || 1, 1, 4);
    stepBarEl.querySelectorAll('[data-step]').forEach((el) => {
        const n = Number(el.getAttribute('data-step'));
        const isActive = n === active;
        const isDone = n < active;
        el.classList.toggle('opacity-100', isActive || isDone);
        el.classList.toggle('opacity-70', !isActive && !isDone);
        const dot = el.querySelector('[data-step-dot]');
        if (!dot) return;
        dot.className = isActive
            ? 'inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/25 ring-1 ring-white/50'
            : isDone
                ? 'inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-400/90 text-[#0b3b1a] ring-1 ring-white/30'
                : 'inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/25';
        if (isDone) {
            dot.textContent = '✓';
        } else {
            dot.textContent = String(n);
        }
    });
};

const setViewMode = (text) => {
    if (viewModeLabelEl) viewModeLabelEl.textContent = text;
};

const updateTaskSummary = () => {
    if (!taskSummaryEl) return;
    const rows = [...chunkTasks.values()];
    if (rows.length === 0) {
        taskSummaryEl.textContent = '等待开始';
        return;
    }
    const done = rows.filter((t) => t.status === '已计算').length;
    const failed = rows.filter((t) => t.status === '计算失败').length;
    const running = rows.filter((t) => t.status === '正在计算' || t.status === '正在写入资源').length;
    if (failed > 0) {
        taskSummaryEl.textContent = `${done}/${rows.length} 完成 · ${failed} 失败`;
        return;
    }
    if (running > 0) {
        taskSummaryEl.textContent = `${done}/${rows.length} 完成 · ${running} 进行中`;
        return;
    }
    taskSummaryEl.textContent = `${done}/${rows.length} 完成`;
};

const setProgress = (text, percent = null) => {
    progressText.textContent = humanizeProgressLine(text);
    if (percent == null || !Number.isFinite(percent)) return;
    progressBar.style.width = `${clamp(percent, 0, 100)}%`;
};

const setHelpOpen = (open) => {
    if (!helpModal) return;
    helpModal.classList.toggle('hidden', !open);
    helpModal.classList.toggle('flex', open);
};

const clearCurrentLevelRender = () => {
    while (chunkEntities.length > 0) {
        const entity = chunkEntities.pop();
        entity.destroy();
    }
    loadedChunks.clear();
    loadingChunks.clear();
    loadedChunkCount = 0;
    chunkCountEl.textContent = '0';
    pendingChunkLoads.clear();
    showingFinalLod = false;
    previewMode = PREVIEW_MODE.none;
};

const loadGsplatUrl = async (url, options = {}) => {
    const {
        name = `gsplat-${Date.now()}`,
        // PlayCanvas global sorting: all unified gsplat components share one depth sort.
        // Without this, multi-chunk previews occlude each other by entity order (wrong).
        unified = true,
        lodBaseDistance = 10,
        lodMultiplier = 1,
        retries = 6,
        /** When false, skip auto camera framing (e.g. loading many chunks) */
        frameCamera = true
    } = options;

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            const cacheBusted = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}-${attempt}`;
            const asset = new Asset(name, 'gsplat', { url: cacheBusted });
            const loader = new AssetListLoader([asset], app.assets);
            await new Promise((resolve, reject) => {
                loader.load((err) => (err ? reject(err) : resolve()));
            });

            const entity = new Entity(name);
            entity.setEulerAngles(0, 0, 180);
            const gsplatOpts = {
                asset,
                unified
            };
            // LOD streaming params only apply to hierarchical lod-meta assets
            if (unified && options.useLodDistances) {
                gsplatOpts.lodBaseDistance = lodBaseDistance;
                gsplatOpts.lodMultiplier = lodMultiplier;
            }
            entity.addComponent('gsplat', gsplatOpts);
            app.root.addChild(entity);
            chunkEntities.push(entity);

            // Ensure component stays on unified/global sort path after load (engine version variance)
            if (entity.gsplat) {
                if (typeof entity.gsplat.unified !== 'undefined') {
                    entity.gsplat.unified = unified;
                }
            }

            if (frameCamera) {
                // Defer framing one frame so gsplat AABB is ready
                requestAnimationFrame(() => {
                    frameEntityInView(entity);
                    syncCameraClipPlanes();
                });
            }
            return entity;
        } catch (error) {
            lastError = error;
            await sleep(350 + attempt * 250);
        }
    }
    throw lastError || new Error('Failed to load gsplat');
};

/**
 * Phase 1 preview: show a single intermediate simplified model (one level at a time).
 */
const loadIntermediatePreview = async (data) => {
    if (!data?.previewUrl || data.skipPreview || data.isSource) {
        setViewMode(data?.isSource
            ? 'L0 使用原文件（不单独预览）'
            : `L${data?.lod} 中间文件已就绪（过大，跳过预览）`);
        return false;
    }
    if (pipelinePhase !== 1 && pipelinePhase !== 0) return false;

    clearCurrentLevelRender();
    previewMode = PREVIEW_MODE.intermediate;
    currentLod = Number(data.lod);
    currentLodEl.textContent = `L${currentLod}`;
    setViewMode(`阶段1 中间预览 · L${currentLod}`);
    setProgress(`正在加载中间文件预览 L${currentLod}…`);

    try {
        // Single intermediate model: unified still fine; one component only
        await loadGsplatUrl(data.previewUrl, {
            name: `intermediate-L${data.lod}`,
            unified: true,
            frameCamera: true,
            retries: 5
        });
        chunkCountEl.textContent = '1';
        loadedChunkCount = 1;
        setChunkTaskStatus(data.taskName || `中间 L${data.lod}`, '已计算', 100);
        renderTaskTable();
        setProgress(`阶段1：L${data.lod} 中间结果预览中`);
        return true;
    } catch (error) {
        setViewMode(`L${data.lod} 中间预览失败`);
        setProgress(`中间文件预览失败 L${data.lod}: ${error.message || error}（文件仍可用于合成）`);
        setChunkTaskStatus(data.taskName || `中间 L${data.lod}`, '已计算', 100);
        renderTaskTable();
        return false;
    }
};

/**
 * Load hierarchical multi-LOD dataset via lod-meta.json (PlayCanvas unified streaming).
 */
const loadFinalLodMeta = async (metaUrl) => {
    if (!metaUrl) return false;
    clearCurrentLevelRender();
    showingFinalLod = true;
    previewMode = PREVIEW_MODE.final;
    pipelinePhase = 3;
    currentLodEl.textContent = 'ALL';

    try {
        await loadGsplatUrl(metaUrl, {
            name: `lod-final-${Date.now()}`,
            unified: true,
            useLodDistances: true,
            lodBaseDistance: 10,
            lodMultiplier: 1,
            frameCamera: true,
            retries: 6
        });
        chunkCountEl.textContent = 'meta';
        setViewMode('阶段完成 · 分层流式 lod-meta');
        setWorkflowStep(4);
        setStatusPhase('完成', 'ok');
        setProgress('转换完成：已加载完整多层 LOD，可在视口中检查效果。', 100);
        return true;
    } catch (error) {
        setStatusPhase('完成(预览失败)', 'warn');
        setProgress(`最终 lod-meta 加载失败: ${error.message || error}`);
        return false;
    }
};

const queueChunkForLevel = (data) => {
    const lod = Number(data.lod);
    if (!Number.isFinite(lod)) return;
    if (!levelChunkQueue.has(lod)) {
        levelChunkQueue.set(lod, new Map());
    }
    levelChunkQueue.get(lod).set(data.chunkName, {
        runId: data.runId,
        lod,
        chunkName: data.chunkName,
        metaUrl: data.metaUrl
    });
};

const ensureChunkTask = (chunkName) => {
    if (!chunkName) return null;
    if (!chunkTasks.has(chunkName)) {
        chunkTasks.set(chunkName, {
            progress: 0,
            status: '待计算'
        });
    }
    return chunkTasks.get(chunkName);
};

const setChunkTaskProgress = (chunkName, nextProgress, fallbackStatus = null) => {
    const task = ensureChunkTask(chunkName);
    if (!task) return;
    if (Number.isFinite(nextProgress)) {
        task.progress = clamp(Number(nextProgress), 0, 100);
    }
    if (fallbackStatus && task.status !== '已计算' && task.status !== '计算失败') {
        task.status = fallbackStatus;
    }
};

const setChunkTaskStatus = (chunkName, status, progress = null) => {
    const task = ensureChunkTask(chunkName);
    if (!task) return;
    if (progress != null && Number.isFinite(progress)) {
        task.progress = clamp(Number(progress), 0, 100);
    }
    task.status = status;
};

const renderTaskTable = () => {
    const statusStyle = (status) => {
        switch (status) {
            case '正在计算':
                return { dot: '#0d74ce', text: '#0d74ce' };
            case '正在写入资源':
                return { dot: '#7256d9', text: '#7256d9' };
            case '已计算':
                return { dot: '#3f8500', text: '#3f8500' };
            case '已停止':
                return { dot: '#ab6400', text: '#ab6400' };
            case '计算失败':
                return { dot: '#cf2a2a', text: '#cf2a2a' };
            default:
                return { dot: '#999999', text: '#60646c' };
        }
    };

    taskTableBodyEl.innerHTML = '';
    const rows = [...chunkTasks.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
    rows.forEach(([chunkName, task]) => {
        const style = statusStyle(task.status);
        const percent = Math.round(task.progress);
        const row = document.createElement('tr');
        row.className = 'border-b border-[#e0e1e6] text-[#1c2024]';
        row.innerHTML = `
            <td class="px-2 py-1 font-mono text-[11px]">${chunkName}</td>
            <td class="px-2 py-1">
                <div class="flex items-center gap-2">
                    <div class="h-2 flex-1 min-w-0 rounded-full bg-[#e7e9ef] overflow-hidden">
                        <div class="h-full rounded-full transition-all" style="width:${percent}%;background:${style.dot}"></div>
                    </div>
                    <span class="text-[11px] text-[#60646c] tabular-nums w-9 text-right">${percent}%</span>
                </div>
            </td>
            <td class="px-2 py-1">
                <span class="inline-flex items-center gap-1" style="color:${style.text}">
                    <span class="inline-block w-2 h-2 rounded-full" style="background:${style.dot}"></span>
                    <span>${task.status}</span>
                </span>
            </td>
        `;
        taskTableBodyEl.appendChild(row);
    });

    if (rows.length === 0) {
        const row = document.createElement('tr');
        row.className = 'border-b border-[#e0e1e6] text-[#60646c]';
        row.innerHTML = '<td class="px-2 py-2" colspan="3">暂无分块任务。开始转换后会在此显示。</td>';
        taskTableBodyEl.appendChild(row);
    }
    updateTaskSummary();
};

const setUiRunningState = (running) => {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    startBtn.setAttribute('aria-busy', running ? 'true' : 'false');
    if (startBtnLabel) {
        startBtnLabel.textContent = running ? '转换中…' : '开始转换';
    }
    if (startBtnSpinner) {
        startBtnSpinner.classList.toggle('hidden', !running);
    }

    const selectors = [
        '#inputPath',
        '#outputRoot',
        '#pickInputBtn',
        '#pickOutputBtn',
        '#lodCount',
        '#chunkCountK',
        '#levelForm input',
        '#inputFileHidden'
    ];
    selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
            el.disabled = running;
        });
    });
    if (inputDropZone) {
        inputDropZone.classList.toggle('pointer-events-none', running);
        inputDropZone.classList.toggle('opacity-60', running);
    }

    settingsPanelEl.classList.toggle('opacity-60', running);
    settingsPanelEl.classList.toggle('pointer-events-none', running);
};

const basenameFromPath = (filePath) => {
    const text = `${filePath ?? ''}`.trim().replaceAll('\\', '/');
    if (!text) return '';
    const parts = text.split('/');
    return parts[parts.length - 1] || '';
};

const stripKnownExtension = (fileName) => {
    let name = `${fileName ?? ''}`;
    const lower = name.toLowerCase();
    if (lower.endsWith('.compressed.ply')) {
        return name.slice(0, -'.compressed.ply'.length);
    }
    for (const ext of INPUT_EXTS) {
        if (lower.endsWith(ext)) {
            return name.slice(0, -ext.length);
        }
    }
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
};

const sanitizeOutputFolderName = (name) => {
    const cleaned = `${name ?? ''}`
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+/, '')
        .replace(/\.+$/, '');
    return cleaned || 'lod-output';
};

const suggestOutputFromInput = (inputPath) => {
    const base = stripKnownExtension(basenameFromPath(inputPath));
    if (!base) return '';
    return `output/${sanitizeOutputFolderName(base)}`;
};

const updateInputDropHint = (pathValue) => {
    if (!inputDropHint) return;
    const text = `${pathValue ?? ''}`.trim();
    inputDropHint.textContent = text ? text : '未选择文件';
    inputDropHint.title = text;
};

/**
 * Auto-fill output directory from input filename when user hasn't customized it.
 * Pattern: input/foo.ply → output/foo
 */
const maybeAutoFillOutput = (inputPath, { force = false } = {}) => {
    const suggested = suggestOutputFromInput(inputPath);
    if (!suggested) return;
    const current = outputRootEl.value.trim();
    const shouldUpdate = force
        || !current
        || current === lastSuggestedOutput
        || current === 'output/live-lod'
        || /^output\/[^/\\]+$/.test(current);
    if (shouldUpdate) {
        outputRootEl.value = suggested;
        lastSuggestedOutput = suggested;
    }
};

const setInputPathValue = (value, { autoOutput = true, forceOutput = false } = {}) => {
    const next = `${value ?? ''}`.trim();
    inputPathEl.value = next;
    updateInputDropHint(next);
    if (autoOutput && next) {
        maybeAutoFillOutput(next, { force: forceOutput });
    }
    setWorkflowStep(next && outputRootEl.value.trim() ? 2 : 1);
    saveConfigToStorage();
};

const resolveDroppedInput = async (fileName, optionalPath = '') => {
    const res = await fetch('/api/resolve-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, path: optionalPath || undefined })
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || '解析输入路径失败');
    }
    return data;
};

const applyResolvedInput = async (fileName, optionalPath = '') => {
    const data = await resolveDroppedInput(fileName, optionalPath);
    setInputPathValue(data.value, { autoOutput: true, forceOutput: false });
    if (data.found) {
        setProgress(`已选择输入：${data.value}`);
    } else {
        setProgress(data.message || `已填入建议路径：${data.value}`);
    }
    return data;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatNumber = (num) => {
    const rounded = Math.round(num);
    if (Math.abs(num - rounded) < 1e-9) return String(rounded);
    return String(num);
};

const parsePercentToNumberString = (value) => {
    const text = `${value ?? ''}`.trim();
    if (!text) return '';
    const normalized = text.endsWith('%') ? text.slice(0, -1) : text;
    const num = Number(normalized);
    if (!Number.isFinite(num)) return '';
    return formatNumber(clamp(num, 0, 100));
};

const buildPercentFromNumberString = (value) => {
    const text = `${value ?? ''}`.trim();
    if (!text) return '';
    const num = Number(text);
    if (!Number.isFinite(num)) return '';
    return `${formatNumber(clamp(num, 0, 100))}%`;
};

const tryLoadChunkIntoViewer = async (data, cycle = 1) => {
    // Chunk preview only in phase 2 compose (not during intermediate simplify / final)
    if (showingFinalLod || previewMode === PREVIEW_MODE.final) return false;
    if (pipelinePhase !== 2 && previewMode !== PREVIEW_MODE.chunks) return false;
    if (activeRunId && data.runId !== activeRunId) return;
    if (currentLod !== Number(data.lod)) return false;
    if (loadedChunks.has(data.chunkName) || loadingChunks.has(data.chunkName)) return true;

    loadingChunks.add(data.chunkName);
    try {
        // Must use unified:true so all LOD chunks share global Gaussian depth sort
        // (otherwise chunks occlude each other incorrectly by entity draw order).
        await loadGsplatUrl(data.metaUrl, {
            name: `chunk-L${data.lod}-${data.chunkName}`,
            unified: true,
            // Only frame on first chunk of a level to avoid camera jumping
            frameCamera: loadedChunkCount === 0,
            retries: 8
        });
        loadedChunks.add(data.chunkName);
        loadedChunkCount += 1;
        chunkCountEl.textContent = String(loadedChunkCount);
        setChunkTaskStatus(data.chunkName, '已计算', 100);
        renderTaskTable();
        setProgress(`阶段2：L${data.lod} 已加载分块 ${data.chunkName}`);
        return true;
    } catch (error) {
        if (cycle < 4 && (!activeRunId || data.runId === activeRunId) && currentLod === Number(data.lod) && !showingFinalLod) {
            setProgress(`分块写入中，重试(${cycle}/4): ${data.chunkName}`);
            await sleep(700 * cycle);
            return tryLoadChunkIntoViewer(data, cycle + 1);
        }
        setChunkTaskStatus(data.chunkName, '计算失败');
        renderTaskTable();
        setProgress(`块加载失败: ${data.chunkName} (${error.message || error})`);
        return false;
    } finally {
        loadingChunks.delete(data.chunkName);
    }
};

const queueChunkLoadNow = (data) => {
    const lod = Number(data.lod);
    if (!Number.isFinite(lod)) return;
    if (currentLod !== lod) return;
    if (loadedChunks.has(data.chunkName) || loadingChunks.has(data.chunkName)) return;
    if (pendingChunkLoads.has(data.chunkName)) return;
    pendingChunkLoads.set(data.chunkName, data);
};

const pumpChunkLoads = async () => {
    if (isChunkLoadPumping) return;
    isChunkLoadPumping = true;
    try {
        while (pendingChunkLoads.size > 0) {
            const next = pendingChunkLoads.entries().next().value;
            if (!next) break;
            const [chunkName, chunkData] = next;
            pendingChunkLoads.delete(chunkName);
            if (activeRunId && chunkData.runId !== activeRunId) continue;
            if (currentLod !== Number(chunkData.lod)) continue;
            await tryLoadChunkIntoViewer(chunkData);
        }
    } finally {
        isChunkLoadPumping = false;
    }
};

const saveConfigToStorage = () => {
    try {
        const levels = levelFormEl.querySelector('[data-level-row]')
            ? collectLevelsFromUi()
            : levelState;
        const payload = {
            inputPath: inputPathEl.value.trim(),
            outputRoot: outputRootEl.value.trim(),
            lodCount: Number(lodCountEl.value) || levels.length,
            chunkCountK: Math.max(1, Number(chunkCountKEl?.value) || 512),
            levels
        };
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore quota / private mode
    }
};

const loadConfigFromStorage = () => {
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const applyConfigToForm = (cfg) => {
    if (!cfg) return;
    if (cfg.inputPath) {
        inputPathEl.value = cfg.inputPath;
        updateInputDropHint(cfg.inputPath);
    }
    if (cfg.outputRoot) {
        outputRootEl.value = cfg.outputRoot;
        lastSuggestedOutput = suggestOutputFromInput(cfg.inputPath || '') || cfg.outputRoot;
    }
    if (chunkCountKEl && cfg.chunkCountK) {
        chunkCountKEl.value = String(Math.max(1, Number(cfg.chunkCountK) || 512));
    }
    if (Array.isArray(cfg.levels) && cfg.levels.length > 0) {
        levelState = cfg.levels
            .map((level) => ({
                lod: Number(level.lod),
                decimate: `${level.decimate ?? ''}`,
                chunkCountK: Math.max(1, Number(level.chunkCountK) || Number(cfg.chunkCountK) || 512)
            }))
            .filter((level) => Number.isInteger(level.lod) && level.lod >= 0)
            .sort((a, b) => b.lod - a.lod);
        buildLevelForm(levelState);
        lodCountEl.value = String(levelState.length);
    } else if (cfg.lodCount) {
        rebuildLevelsByCount(clamp(Number(cfg.lodCount) || 1, 1, 16));
    }
};

/**
 * Restore UI after page refresh from server snapshot (running or recently finished).
 */
const applyRunSnapshot = async (snapshot, { fromRefresh = false } = {}) => {
    if (!snapshot?.runId) return;

    isRestoringSnapshot = true;
    try {
        activeRunId = snapshot.runId;
        finalLodMetaUrl = snapshot.outputMetaUrl || null;
        pipelinePhase = Number(snapshot.phase) || 0;
        currentLod = snapshot.currentLod ?? null;
        currentChunkName = snapshot.currentChunkName ?? null;
        currentLodEl.textContent = currentLod == null ? '-' : (currentLod === 'ALL' ? 'ALL' : `L${currentLod}`);

        // Restore form fields from run config (do not auto-overwrite with derived output)
        if (snapshot.inputPathAbs || snapshot.inputPath) {
            const inPath = snapshot.inputPathAbs || snapshot.inputPath;
            inputPathEl.value = inPath;
            updateInputDropHint(inPath);
        }
        if (snapshot.outputRoot) {
            outputRootEl.value = snapshot.outputRoot;
            lastSuggestedOutput = snapshot.outputRoot;
        }
        if (chunkCountKEl && snapshot.chunkCountK) {
            chunkCountKEl.value = String(snapshot.chunkCountK);
        }
        if (Array.isArray(snapshot.levels) && snapshot.levels.length > 0) {
            levelState = snapshot.levels.map((level) => ({
                ...level,
                chunkCountK: Math.max(1, Number(level.chunkCountK) || Number(snapshot.chunkCountK) || 512)
            }));
            buildLevelForm(levelState);
            lodCountEl.value = String(levelState.length);
        }
        saveConfigToStorage();

        chunkTasks.clear();
        levelChunkQueue.clear();
        (snapshot.levels || []).forEach((level) => {
            const lod = Number(level.lod);
            if (Number.isFinite(lod)) levelChunkQueue.set(lod, new Map());
        });
        (snapshot.tasks || []).forEach((task) => {
            let progress = Number(task.progress) || 0;
            let status = task.status || '待计算';
            // Normalize legacy snapshot bug: 95% + 正在写入资源 => already written
            if (status === '正在写入资源' || (progress >= 95 && status !== '计算失败' && status !== '已停止')) {
                progress = 100;
                status = '已计算';
            }
            chunkTasks.set(task.name, { progress, status });
        });

        const status = snapshot.status || (snapshot.active ? 'running' : 'complete');
        if (status === 'complete') {
            chunkTasks.forEach((task) => {
                if (task.status !== '计算失败' && task.status !== '已停止') {
                    task.progress = 100;
                    task.status = '已计算';
                }
            });
        }
        renderTaskTable();

        if (status === 'running' || snapshot.active) {
            setUiRunningState(true);
            setWorkflowStep(3);
            if (pipelinePhase === 1) {
                setStatusPhase('阶段1 简化', 'run');
                setViewMode(fromRefresh ? '已恢复 · 阶段1 进行中' : '阶段1 · 生成中间文件');
            } else if (pipelinePhase === 2) {
                setStatusPhase('阶段2 合成', 'run');
                setViewMode(fromRefresh ? '已恢复 · 阶段2 进行中' : '阶段2 · 合成分块');
                previewMode = PREVIEW_MODE.chunks;
            } else {
                setStatusPhase('转换中', 'run');
                setViewMode(fromRefresh ? '已恢复转换会话' : '两段式流水线');
            }
            setProgress(
                fromRefresh
                    ? `页面已刷新，已接回进行中的任务。${snapshot.lastLine ? ` ${snapshot.lastLine}` : ''}`
                    : (snapshot.lastLine || '转换进行中…'),
                snapshot.lastPercent ?? 0
            );
        } else if (status === 'complete') {
            setUiRunningState(false);
            setWorkflowStep(4);
            setStatusPhase('完成', 'ok');
            setProgress(snapshot.lastLine || '上次转换已完成。', 100);
            setViewMode('可加载最终 lod-meta');
            if (snapshot.outputMetaUrl) {
                await loadFinalLodMeta(snapshot.outputMetaUrl);
            }
        } else if (status === 'stopped') {
            setUiRunningState(false);
            setWorkflowStep(2);
            setStatusPhase('已停止', 'warn');
            setProgress(snapshot.lastLine || '上次任务已停止。', snapshot.lastPercent ?? null);
        } else if (status === 'error') {
            setUiRunningState(false);
            setWorkflowStep(2);
            setStatusPhase('失败', 'err');
            setProgress(snapshot.errorMessage || snapshot.lastLine || '上次任务失败。', snapshot.lastPercent ?? null);
        }
    } finally {
        isRestoringSnapshot = false;
    }
};

const eventSource = new EventSource('/events');

eventSource.addEventListener('run-snapshot', (evt) => {
    const data = JSON.parse(evt.data);
    // Prefer API restore on boot; this covers late SSE reconnect mid-run
    if (!activeRunId || activeRunId === data.runId) {
        applyRunSnapshot(data, { fromRefresh: true });
    }
});

eventSource.addEventListener('run-start', (evt) => {
    const data = JSON.parse(evt.data);
    activeRunId = data.runId;
    currentLod = null;
    currentChunkName = null;
    finalLodMetaUrl = data.outputMetaUrl || null;
    showingFinalLod = false;
    pipelinePhase = 0;
    previewMode = PREVIEW_MODE.none;
    chunkTasks.clear();
    levelChunkQueue.clear();
    pendingChunkLoads.clear();
    isChunkLoadPumping = false;
    clearCurrentLevelRender();
    ((data.levels || []).map((item) => Number(item.lod)).filter((lod) => Number.isFinite(lod))).forEach((lod) => {
        levelChunkQueue.set(lod, new Map());
    });
    renderTaskTable();
    progressBar.style.width = '0%';
    inputPathEl.value = data.inputPath || inputPathEl.value;
    if (data.outputRoot) outputRootEl.value = data.outputRoot;
    if (Array.isArray(data.levels) && data.levels.length > 0) {
        levelState = data.levels;
        buildLevelForm(levelState);
        lodCountEl.value = String(levelState.length);
    }
    if (chunkCountKEl && data.chunkCountK) {
        chunkCountKEl.value = String(data.chunkCountK);
    }
    saveConfigToStorage();
    resetCameraHome();
    setUiRunningState(true);
    setWorkflowStep(3);
    setStatusPhase('转换中', 'run');
    setViewMode('两段式流水线');
    setProgress('转换已开始：阶段1 简化 → 阶段2 合成 lod-meta', 0);
});

eventSource.addEventListener('phase-start', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    pipelinePhase = Number(data.phase) || 0;
    if (pipelinePhase === 1) {
        setStatusPhase('阶段1 简化', 'run');
        setViewMode('阶段1 · 生成中间文件');
        setProgress(data.title || '阶段 1：串行生成各层中间简化文件…');
    } else if (pipelinePhase === 2) {
        // Leave intermediate scene until first chunk; then switch
        setStatusPhase('阶段2 合成', 'run');
        setViewMode('阶段2 · 合成分块');
        setProgress(data.title || '阶段 2：合成 lod-meta 与分块…');
        previewMode = PREVIEW_MODE.chunks;
        // Clear intermediate model so it won't stack with compose chunks
        clearCurrentLevelRender();
        previewMode = PREVIEW_MODE.chunks;
        showingFinalLod = false;
    }
});

eventSource.addEventListener('phase-complete', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    if (Number(data.phase) === 1) {
        setProgress('阶段1 完成，开始合成 lod-meta…', data.percent ?? null);
    } else if (Number(data.phase) === 2) {
        setProgress('阶段2 完成，准备加载最终分层结果…', data.percent ?? 100);
    }
});

eventSource.addEventListener('intermediate-plan', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    setChunkTaskStatus(data.taskName || `中间 L${data.lod}`, '待计算', 0);
    renderTaskTable();
});

eventSource.addEventListener('intermediate-start', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    pipelinePhase = 1;
    currentLod = Number(data.lod);
    currentLodEl.textContent = Number.isFinite(currentLod) ? `L${currentLod}` : '-';
    setChunkTaskStatus(data.taskName || `中间 L${data.lod}`, '正在计算', 5);
    renderTaskTable();
    setViewMode(`阶段1 简化中 · L${data.lod}（${data.index}/${data.total}）`);
    setProgress(`阶段1 [${data.index}/${data.total}] 正在简化 L${data.lod}（保留 ${data.decimate || '?'}）…`);
});

eventSource.addEventListener('intermediate-ready', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    const taskName = data.taskName || `中间 L${data.lod}`;
    setChunkTaskStatus(taskName, '已计算', 100);
    renderTaskTable();
    // Progressive preview: show latest completed intermediate (coarse-first order)
    if (!data.isSource) {
        loadIntermediatePreview(data);
    }
});

eventSource.addEventListener('level-pending', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    const lod = Number(data.lod);
    if (!Number.isFinite(lod)) return;
    if (!levelChunkQueue.has(lod)) {
        levelChunkQueue.set(lod, new Map());
    }
});

eventSource.addEventListener('level-start', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    if (showingFinalLod) return;
    // Only for phase-2 chunk streaming
    if (pipelinePhase !== 2 && Number(data.phase) !== 2) return;

    const nextLod = Number(data.lod);
    if (!Number.isFinite(nextLod)) return;

    const lodChanged = currentLod !== nextLod;
    currentLod = nextLod;
    currentChunkName = null;
    currentLodEl.textContent = `L${currentLod}`;
    previewMode = PREVIEW_MODE.chunks;

    if (lodChanged) {
        clearCurrentLevelRender();
        previewMode = PREVIEW_MODE.chunks;
        showingFinalLod = false;
        const alreadyQueuedChunks = [...(levelChunkQueue.get(currentLod)?.values() || [])];
        alreadyQueuedChunks.forEach((chunk) => {
            setChunkTaskStatus(chunk.chunkName, '待计算', 0);
        });
        renderTaskTable();
        alreadyQueuedChunks.forEach(queueChunkLoadNow);
        pumpChunkLoads();
        setViewMode(`阶段2 分块预览 · L${currentLod}`);
        setProgress(`阶段2：正在预览 L${currentLod} 分块…`);
    } else {
        renderTaskTable();
    }
});

eventSource.addEventListener('chunk-plan', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    const names = Array.isArray(data.chunkNames) ? data.chunkNames : [];
    names.forEach((chunkName) => {
        setChunkTaskStatus(chunkName, '待计算', 0);
    });
    renderTaskTable();
});

eventSource.addEventListener('chunk-start', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    const chunkName = data.chunkName || null;
    currentChunkName = chunkName;
    if (chunkName) {
        setChunkTaskProgress(chunkName, 1, '正在计算');
        renderTaskTable();
    }
});

eventSource.addEventListener('chunk-ready', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    queueChunkForLevel(data);
    // Disk write is finished when chunk-ready fires (meta.json last). Mark complete immediately
    // so refresh/snapshot never sticks at 95% "正在写入资源".
    setChunkTaskStatus(data.chunkName, '已计算', 100);
    renderTaskTable();

    if (pipelinePhase !== 2 && previewMode !== PREVIEW_MODE.chunks) {
        return;
    }

    const lod = Number(data.lod);
    if (Number.isFinite(lod) && currentLod == null) {
        currentLod = lod;
        currentLodEl.textContent = `L${currentLod}`;
    }

    if (!showingFinalLod) {
        queueChunkLoadNow(data);
        pumpChunkLoads();
    }
});

eventSource.addEventListener('progress', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    if (data.phase != null) pipelinePhase = Number(data.phase) || pipelinePhase;
    if (data.lod != null) {
        currentLod = data.lod;
        currentLodEl.textContent = `L${currentLod}`;
    }
    const progressChunkName = data.chunkName || currentChunkName;
    if (progressChunkName && data.chunkPercent != null) {
        setChunkTaskProgress(progressChunkName, Math.min(99, Number(data.chunkPercent)), '正在计算');
        renderTaskTable();
    }
    setProgress(data.line, data.percent);
});

eventSource.addEventListener('level-complete', (evt) => {
    const data = JSON.parse(evt.data);
    const lod = Number(data.lod);
    if (activeRunId && data.runId !== activeRunId) return;
    if (currentLod === lod) {
        currentChunkName = null;
    }
    const chunkMap = levelChunkQueue.get(lod) || new Map();
    [...chunkTasks.entries()].forEach(([chunkName, task]) => {
        if (!chunkName.startsWith(`${lod}_`)) return;
        if (task.status !== '已计算') {
            task.status = '已计算';
            task.progress = 100;
        }
    });
    renderTaskTable();
    if (chunkMap.size === 0) {
        setProgress(`L${lod} 计算完成，但暂未发现可渲染块。`);
        return;
    }
    setProgress(`L${lod} 计算完成，当前已实时加载 ${loadedChunkCount}/${chunkMap.size} 个块。`);
});

eventSource.addEventListener('run-complete', async (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    currentChunkName = null;
    chunkTasks.forEach((task) => {
        task.progress = 100;
        task.status = '已计算';
    });
    renderTaskTable();
    setUiRunningState(false);
    setWorkflowStep(4);
    setStatusPhase('加载预览', 'run');

    const metaUrl = data.outputMetaUrl || finalLodMetaUrl;
    finalLodMetaUrl = metaUrl;
    const outHint = outputRootEl.value.trim() || '输出目录';
    setProgress(`计算完成，正在加载分层结果… 输出：${outHint}`, 100);

    // Keep runId until final load finishes so late chunk-ready events still match
    const completedRunId = activeRunId;
    const loaded = await loadFinalLodMeta(metaUrl);
    if (activeRunId === completedRunId) {
        activeRunId = null;
    }
    if (!loaded) {
        setStatusPhase('完成(预览失败)', 'warn');
        setProgress(`文件已写出到「${outHint}」，但视口预览失败。可检查 lod-meta.json。`, 100);
    } else {
        setProgress(`完成。结果已写入「${outHint}」，视口为分层流式预览。`, 100);
    }
});

eventSource.addEventListener('run-error', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    if (currentChunkName) {
        setChunkTaskStatus(currentChunkName, '计算失败');
        renderTaskTable();
    }
    setUiRunningState(false);
    activeRunId = null;
    currentChunkName = null;
    setWorkflowStep(2);
    setStatusPhase('失败', 'err');
    setViewMode('转换失败');
    setProgress(`运行失败: ${data.message}`);
});

eventSource.addEventListener('run-stopped', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    if (currentChunkName) {
        setChunkTaskStatus(currentChunkName, '已停止');
    }
    renderTaskTable();
    currentChunkName = null;
    activeRunId = null;
    setUiRunningState(false);
    setWorkflowStep(2);
    setStatusPhase('已停止', 'warn');
    setViewMode('已停止');
    setProgress('任务已停止。可修改参数后重新开始。');
});

const collectLevelsFromUi = () => {
    const rows = [...levelFormEl.querySelectorAll('[data-level-row]')];
    const globalChunk = Math.max(1, Number(chunkCountKEl?.value) || 512);
    return rows.map((row) => {
        const lod = Number(row.getAttribute('data-lod'));
        const isL0 = lod === 0;
        // L0 keeps full detail — do not send -F 100%
        const decimate = isL0
            ? ''
            : buildPercentFromNumberString(row.querySelector('[data-decimate]').value);
        return {
            lod,
            decimate,
            chunkCountK: globalChunk
        };
    }).sort((a, b) => b.lod - a.lod);
};

const buildLevelForm = (levels) => {
    levelFormEl.innerHTML = '';
    levels.sort((a, b) => b.lod - a.lod).forEach((level) => {
        const lod = Number(level.lod);
        const isL0 = lod === 0;
        const decimateNumber = isL0 ? '100' : parsePercentToNumberString(level.decimate);
        const role = isL0 ? '近景 · 全量' : lod >= 4 ? '远景' : lod >= 2 ? '中景' : '中近景';
        const row = document.createElement('div');
        row.setAttribute('data-level-row', '1');
        row.setAttribute('data-lod', String(lod));
        row.className = 'rounded-xl border border-[#dbe3f0] bg-white px-3 py-2.5 shadow-[0_8px_18px_rgba(12,28,60,0.06)] min-w-0';
        row.innerHTML = `
            <div class="flex items-center gap-3 min-w-0">
                <div class="shrink-0 w-14">
                    <div class="inline-flex items-center justify-center rounded-lg bg-[#eef6ff] text-[#0b5fb9] text-[12px] font-bold px-2 py-1">L${lod}</div>
                    <div class="text-[10px] text-[#7b8494] mt-1 leading-tight">${role}</div>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2 mb-1">
                        <span class="text-[12px] text-[#526077]">保留率</span>
                        <span class="text-[11px] text-[#7b8494]">${isL0 ? '固定 100%' : '相对原始点数'}</span>
                    </div>
                    <div class="relative">
                        <input data-decimate ${isL0 ? 'disabled' : ''} class="w-full border border-[#cfd9ea] bg-white text-[#0b1220] px-2 py-1.5 pr-7 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1d6feb]/20 focus:border-[#1d6feb] disabled:opacity-50 disabled:bg-[#f4f6fa]" type="number" min="1" max="100" step="1" value="${decimateNumber}" placeholder="例如 40">
                        <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-[#526077]">%</span>
                    </div>
                </div>
            </div>
        `;
        levelFormEl.appendChild(row);
    });
};

const suggestDecimateByIndex = (indexFromTop, lod) => {
    if (lod === 0) return '100%';
    const presets = ['15%', '25%', '40%', '60%', '80%'];
    return presets[Math.min(indexFromTop, presets.length - 1)];
};

const normalizeLodCountInput = () => {
    const value = Number(lodCountEl.value);
    const count = clamp(Number.isFinite(value) ? Math.round(value) : 1, 1, 16);
    lodCountEl.value = String(count);
    return count;
};

const rebuildLevelsByCount = (count) => {
    const current = collectLevelsFromUi();
    const decimateMap = new Map(current.map((item) => [item.lod, item.decimate]));
    const globalChunk = Math.max(1, Number(chunkCountKEl?.value) || current[0]?.chunkCountK || 512);

    const next = [];
    for (let lod = count - 1; lod >= 0; lod -= 1) {
        const indexFromTop = (count - 1) - lod;
        next.push({
            lod,
            decimate: decimateMap.has(lod) ? decimateMap.get(lod) : suggestDecimateByIndex(indexFromTop, lod),
            chunkCountK: globalChunk
        });
    }

    levelState = next;
    buildLevelForm(levelState);
    lodCountEl.value = String(levelState.length);
};

const initializeDefaults = async () => {
    const res = await fetch('/api/defaults');
    const defaults = await res.json();

    // 1) Server defaults
    inputPathEl.value = defaults.inputPath;
    updateInputDropHint(defaults.inputPath);
    const defaultOut = suggestOutputFromInput(defaults.inputPath) || defaults.outputRoot;
    outputRootEl.value = defaultOut;
    lastSuggestedOutput = defaultOut;
    if (chunkCountKEl) {
        chunkCountKEl.value = String(Math.max(1, Number(defaults.chunkCountK) || defaults.levels?.[0]?.chunkCountK || 512));
    }
    levelState = defaults.levels
        .map((level) => ({
            ...level,
            chunkCountK: Math.max(1, Number(level.chunkCountK) || 512)
        }))
        .sort((a, b) => b.lod - a.lod);
    buildLevelForm(levelState);
    lodCountEl.value = String(levelState.length);

    // 2) Overlay last local form config (survives refresh)
    const saved = loadConfigFromStorage();
    if (saved) {
        applyConfigToForm(saved);
        // If saved input exists but output empty, auto-fill
        if (saved.inputPath && !`${saved.outputRoot || ''}`.trim()) {
            maybeAutoFillOutput(saved.inputPath, { force: true });
        }
    }

    setWorkflowStep(inputPathEl.value.trim() && outputRootEl.value.trim() ? 2 : 1);
    setStatusPhase('就绪', 'idle');
    setViewMode('等待数据');

    // 3) Restore in-flight / last run from server (survives refresh during conversion)
    try {
        const statusRes = await fetch('/api/status');
        const status = await statusRes.json();
        if (status?.run) {
            await applyRunSnapshot(status.run, { fromRefresh: true });
        }
    } catch (error) {
        setProgress(`恢复任务状态失败: ${error.message || error}`);
    }
};

const pickPath = async (kind) => {
    const res = await fetch('/api/pick-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind })
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || '路径选择失败');
    }
    if (data.cancelled) {
        return null;
    }
    return data.value;
};

const validateBeforeStart = () => {
    const inputPath = inputPathEl.value.trim();
    const outputRoot = outputRootEl.value.trim();
    if (!inputPath) {
        setProgress('请先选择输入文件（步骤 1）。');
        setWorkflowStep(1);
        setStatusPhase('缺少输入', 'warn');
        inputPathEl.focus();
        return null;
    }
    if (!outputRoot) {
        setProgress('请先填写输出目录（步骤 1）。');
        setWorkflowStep(1);
        setStatusPhase('缺少输出', 'warn');
        outputRootEl.focus();
        return null;
    }

    const latestCount = normalizeLodCountInput();
    if (latestCount !== levelState.length) {
        rebuildLevelsByCount(latestCount);
    }
    levelState = collectLevelsFromUi();
    if (levelState.length === 0) {
        setProgress('至少需要 1 个 LOD 层级。');
        setWorkflowStep(2);
        return null;
    }

    // Non-L0 levels should keep a sensible ratio
    for (const level of levelState) {
        if (level.lod === 0) continue;
        const n = Number(`${level.decimate}`.replace('%', ''));
        if (!Number.isFinite(n) || n <= 0 || n >= 100) {
            setProgress(`L${level.lod} 保留率需在 1%–99% 之间。`);
            setWorkflowStep(2);
            setStatusPhase('参数无效', 'warn');
            return null;
        }
    }

    const chunkCountK = Math.max(1, Number(chunkCountKEl?.value) || levelState[0]?.chunkCountK || 512);
    if (chunkCountKEl) chunkCountKEl.value = String(chunkCountK);

    return {
        inputPath,
        outputRoot,
        levels: levelState,
        chunkCountK,
        // Keep intermediates when possible (large-data friendly). Full rebuild: delete output dir first.
        resume: true
    };
};

startBtn.addEventListener('click', async () => {
    const payload = validateBeforeStart();
    if (!payload) return;

    saveConfigToStorage();
    setWorkflowStep(3);
    setStatusPhase('启动中', 'run');
    setProgress('正在启动转换…', 0);

    const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
        setUiRunningState(false);
        setWorkflowStep(2);
        setStatusPhase('启动失败', 'err');
        setProgress(`启动失败: ${data.error || '未知错误'}`);
    }
});

stopBtn.addEventListener('click', async () => {
    await fetch('/api/stop', { method: 'POST' });
});

pickInputBtn.addEventListener('click', async () => {
    try {
        const value = await pickPath('input');
        if (value) {
            setInputPathValue(value, { autoOutput: true, forceOutput: false });
            setProgress(`已选择输入：${value}`);
        }
    } catch (error) {
        setProgress(`选择输入文件失败: ${error.message || error}`);
    }
});

pickOutputBtn.addEventListener('click', async () => {
    try {
        const value = await pickPath('output');
        if (value) {
            outputRootEl.value = value;
            lastSuggestedOutput = value; // treat as intentional selection
            setWorkflowStep(inputPathEl.value.trim() && outputRootEl.value.trim() ? 2 : 1);
            saveConfigToStorage();
            setProgress(`已选择输出：${value}`);
        }
    } catch (error) {
        setProgress(`选择输出目录失败: ${error.message || error}`);
    }
});

const onPathInput = () => {
    if (activeRunId && !isRestoringSnapshot) return;
    updateInputDropHint(inputPathEl.value);
    // Typing input path keeps auto-output in sync when still on default pattern
    if (inputPathEl === document.activeElement || document.activeElement === inputPathEl) {
        maybeAutoFillOutput(inputPathEl.value, { force: false });
    }
    const ready = inputPathEl.value.trim() && outputRootEl.value.trim();
    setWorkflowStep(ready ? 2 : 1);
    saveConfigToStorage();
};

inputPathEl.addEventListener('input', () => {
    if (activeRunId && !isRestoringSnapshot) return;
    updateInputDropHint(inputPathEl.value);
    maybeAutoFillOutput(inputPathEl.value, { force: false });
    setWorkflowStep(inputPathEl.value.trim() && outputRootEl.value.trim() ? 2 : 1);
    saveConfigToStorage();
});

outputRootEl.addEventListener('input', () => {
    if (activeRunId && !isRestoringSnapshot) return;
    // User is editing output manually — only re-auto if they clear it
    const current = outputRootEl.value.trim();
    if (!current) {
        lastSuggestedOutput = '';
        maybeAutoFillOutput(inputPathEl.value, { force: true });
    } else if (current !== lastSuggestedOutput) {
        // keep lastSuggestedOutput as previous auto value so next input change can still auto if matches old
    }
    setWorkflowStep(inputPathEl.value.trim() && current ? 2 : 1);
    saveConfigToStorage();
});

inputPathEl.addEventListener('change', () => {
    updateInputDropHint(inputPathEl.value);
    maybeAutoFillOutput(inputPathEl.value, { force: false });
    saveConfigToStorage();
});
outputRootEl.addEventListener('change', saveConfigToStorage);

// --- Input drag & drop ---
const setDropZoneActive = (active) => {
    if (!inputDropZone) return;
    inputDropZone.classList.toggle('border-[#1d6feb]', active);
    inputDropZone.classList.toggle('bg-[#e8f2ff]', active);
    inputDropZone.classList.toggle('border-[#b7c9e8]', !active);
};

const isAcceptedInputName = (name) => {
    const lower = `${name ?? ''}`.toLowerCase();
    if (lower.endsWith('.compressed.ply')) return true;
    return INPUT_EXTS.some((ext) => lower.endsWith(ext));
};

const handleDroppedFile = async (file) => {
    if (!file) return;
    const name = file.name || '';
    if (!isAcceptedInputName(name)) {
        setProgress(`不支持的文件类型：${name || '(未知)'}，请使用 .ply / .sog 等`);
        return;
    }
    // Electron / some hosts expose full path; browsers usually do not
    const fullPath = file.path || file.webkitRelativePath || '';
    try {
        await applyResolvedInput(name, fullPath);
    } catch (error) {
        setProgress(`导入失败: ${error.message || error}`);
    }
};

if (inputDropZone) {
    ['dragenter', 'dragover'].forEach((type) => {
        inputDropZone.addEventListener(type, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (activeRunId) return;
            setDropZoneActive(true);
        });
    });
    ['dragleave', 'drop'].forEach((type) => {
        inputDropZone.addEventListener(type, (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropZoneActive(false);
        });
    });
    inputDropZone.addEventListener('drop', async (e) => {
        if (activeRunId) return;
        const dt = e.dataTransfer;
        if (!dt) return;

        // Text path paste-drop (user dragged path text)
        const text = dt.getData('text/plain')?.trim();
        if (text && (text.includes('/') || text.includes('\\') || text.includes(':'))) {
            const base = basenameFromPath(text);
            try {
                await applyResolvedInput(base || text, text);
            } catch (error) {
                setInputPathValue(text, { autoOutput: true });
                setProgress(`已填入路径：${text}`);
            }
            return;
        }

        const file = dt.files?.[0];
        if (file) {
            await handleDroppedFile(file);
            return;
        }
        setProgress('未识别到可导入的文件，请重试或使用浏览按钮。');
    });

    inputDropZone.addEventListener('click', () => {
        if (activeRunId) return;
        // Prefer native OS dialog via server (full path); fall back to file input for name resolve
        pickInputBtn.click();
    });

    inputDropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputDropZone.click();
        }
    });
}

if (inputFileHidden) {
    inputFileHidden.addEventListener('change', async () => {
        const file = inputFileHidden.files?.[0];
        if (file) await handleDroppedFile(file);
        inputFileHidden.value = '';
    });
}

levelFormEl.addEventListener('keydown', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.matches('[data-decimate]')) return;
    if (e.key === 'e' || e.key === 'E' || e.key === '+' || e.key === '-') {
        e.preventDefault();
    }
});

levelFormEl.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.matches('[data-decimate]')) {
        const num = Number(target.value);
        if (!Number.isFinite(num)) return;
        const clamped = clamp(num, 1, 100);
        if (clamped !== num) {
            target.value = formatNumber(clamped);
        }
        if (!activeRunId) setWorkflowStep(2);
        saveConfigToStorage();
    }
});

if (chunkCountKEl) {
    chunkCountKEl.addEventListener('input', () => {
        const num = Number(chunkCountKEl.value);
        if (!Number.isFinite(num)) return;
        const clamped = Math.max(1, Math.round(num));
        if (clamped !== num) chunkCountKEl.value = String(clamped);
        if (!activeRunId) setWorkflowStep(2);
        saveConfigToStorage();
    });
}

lodCountEl.addEventListener('input', () => {
    const count = normalizeLodCountInput();
    if (count === levelState.length) return;
    rebuildLevelsByCount(count);
    if (!activeRunId) setWorkflowStep(2);
    saveConfigToStorage();
});

if (resetCameraBtn) {
    resetCameraBtn.addEventListener('click', () => {
        // Prefer framing loaded content; fall back to origin home view
        let framed = false;
        for (let i = chunkEntities.length - 1; i >= 0; i -= 1) {
            if (frameEntityInView(chunkEntities[i])) {
                framed = true;
                break;
            }
        }
        if (!framed) resetCameraHome();
        else syncCameraClipPlanes();
        setProgress(framed ? '视角已对准模型。' : '视角已重置。');
    });
}

const closeHelp = () => setHelpOpen(false);
if (helpBtn) helpBtn.addEventListener('click', () => setHelpOpen(true));
if (helpCloseBtn) helpCloseBtn.addEventListener('click', closeHelp);
if (helpOkBtn) helpOkBtn.addEventListener('click', closeHelp);
if (helpModal) {
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) closeHelp();
    });
}
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHelp();
});

initializeDefaults().catch((error) => {
    setStatusPhase('初始化失败', 'err');
    setProgress(`默认参数加载失败: ${error.message || error}`);
});

setUiRunningState(false);
setWorkflowStep(1);
setStatusPhase('就绪', 'idle');
