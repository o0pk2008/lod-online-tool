import {
    Application,
    Asset,
    AssetListLoader,
    Color,
    Entity,
    FILLMODE_NONE,
    LAYERID_IMMEDIATE,
    LAYERID_WORLD,
    Layer,
    RESOLUTION_AUTO,
    Vec3,
    Vec4
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
const downloadOutputBtn = document.getElementById('downloadOutputBtn');
const downloadOutputHint = document.getElementById('downloadOutputHint');
const importPreviewBtn = document.getElementById('importPreviewBtn');
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
const lodDebugBtn = document.getElementById('lodDebugBtn');
const lodDebugPanel = document.getElementById('lodDebugPanel');
const lodColorizeToggle = document.getElementById('lodColorizeToggle');
const lodColorLegend = document.getElementById('lodColorLegend');
const lodIsolateSelect = document.getElementById('lodIsolateSelect');
const lodBaseDistanceRange = document.getElementById('lodBaseDistanceRange');
const lodBaseDistanceVal = document.getElementById('lodBaseDistanceVal');
const lodMultiplierRange = document.getElementById('lodMultiplierRange');
const lodMultiplierVal = document.getElementById('lodMultiplierVal');
const helpBtn = document.getElementById('helpBtn');
const helpModal = document.getElementById('helpModal');
const helpCloseBtn = document.getElementById('helpCloseBtn');
const helpOkBtn = document.getElementById('helpOkBtn');
const canvas = document.getElementById('pcanvas');
const modeLodBtn = document.getElementById('modeLodBtn');
const modeCompressBtn = document.getElementById('modeCompressBtn');
const pathDescEl = document.getElementById('pathDesc');
const settingsTitleEl = document.getElementById('settingsTitle');
const settingsDescEl = document.getElementById('settingsDesc');
const lodSettingsBlock = document.getElementById('lodSettingsBlock');
const compressSettingsBlock = document.getElementById('compressSettingsBlock');
const keepPercentRange = document.getElementById('keepPercentRange');
const keepPercentInput = document.getElementById('keepPercentInput');
const keepPercentHint = document.getElementById('keepPercentHint');
const convertTitleEl = document.getElementById('convertTitle');
const convertDescEl = document.getElementById('convertDesc');
const compareUi = document.getElementById('compareUi');
const compareDivider = document.getElementById('compareDivider');
const compareLabelLeft = document.getElementById('compareLabelLeft');
const compareLabelRight = document.getElementById('compareLabelRight');

const CONFIG_STORAGE_KEY = 'lod-online-tool:config:v1';
const INPUT_EXTS = ['.ply', '.sog', '.splat', '.spz', '.ksplat'];
const WORK_MODE = {
    lod: 'lod',
    compress: 'compress'
};
const COPY = {
    lod: {
        pathDesc: '指定高斯模型与输出目录。流水线为两段式（中间 PLY → lod-meta）。',
        settingsTitle: 'LOD 设置',
        settingsDesc: '层数越高越远景越粗糙。保留率越低，该层高斯越少、文件越小。',
        convertTitle: '分块任务',
        convertDesc: '查看中间简化与分块进度，确认后开始转换。',
        startIdle: '开始转换',
        startBusy: '转换中…'
    },
    compress: {
        pathDesc: '指定高斯模型与输出目录。按保留比例简化为单个 PLY，不生成分层 LOD。',
        settingsTitle: '压缩设置',
        settingsDesc: '保留比例越低，高斯越少、文件越小。例如 60% 即压缩到原来的六成。',
        convertTitle: '压缩任务',
        convertDesc: '查看简化进度，确认后开始压缩。完成后可左右对比预览。',
        startIdle: '开始压缩',
        startBusy: '压缩中…'
    }
};

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
    final: 'final',
    compare: 'compare'
};
let previewMode = PREVIEW_MODE.none;
let currentMode = WORK_MODE.lod;
let keepPercent = 60;
let compareSplit = 0.5;
let isDraggingSplit = false;
let lastComparePayload = null;

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

const DEFAULT_CAMERA_LAYERS = camera.camera.layers.slice();
const compareOriginalLayer = new Layer({ name: 'compareOriginal' });
const compareCompressedLayer = new Layer({ name: 'compareCompressed' });
app.scene.layers.push(compareOriginalLayer);
app.scene.layers.push(compareCompressedLayer);

const compareCamera = new Entity('CompareCamera');
compareCamera.addComponent('camera', {
    clearColor: [0.09, 0.1, 0.12, 1],
    nearClip: CAMERA_NEAR,
    farClip: CAMERA_FAR,
    priority: 1,
    layers: [LAYERID_WORLD, LAYERID_IMMEDIATE, compareCompressedLayer.id]
});
compareCamera.camera.clearColorBuffer = false;
compareCamera.camera.clearDepthBuffer = true;
if (compareCamera.camera.camera) {
    compareCamera.camera.camera._scissorRectClear = true;
}
compareCamera.enabled = false;
app.root.addChild(compareCamera);

const formatBytes = (n) => {
    if (n == null || !Number.isFinite(Number(n))) return '?';
    const v = Number(n);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
    return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatCount = (n) => {
    if (n == null || !Number.isFinite(Number(n))) return null;
    return Number(n).toLocaleString('zh-CN');
};

const syncCompareCameraTransform = () => {
    if (!compareCamera.enabled) return;
    compareCamera.setPosition(camera.getPosition());
    compareCamera.setRotation(camera.getRotation());
    const src = camera.camera;
    const dst = compareCamera.camera;
    dst.nearClip = src.nearClip;
    dst.farClip = src.farClip;
    dst.fov = src.fov;
};

const applyCompareSplit = (ratio) => {
    compareSplit = clamp(ratio, 0.08, 0.92);
    if (compareDivider) {
        compareDivider.style.left = `${compareSplit * 100}%`;
    }
    if (!compareCamera.enabled) return;
    camera.camera.scissorRect = new Vec4(0, 0, compareSplit, 1);
    compareCamera.camera.scissorRect = new Vec4(compareSplit, 0, 1 - compareSplit, 1);
};

const setCompareUiVisible = (visible) => {
    if (!compareUi) return;
    compareUi.classList.toggle('hidden', !visible);
};

const disableCompareView = () => {
    compareCamera.enabled = false;
    camera.camera.scissorRect = new Vec4(0, 0, 1, 1);
    camera.camera.layers = DEFAULT_CAMERA_LAYERS.slice();
    setCompareUiVisible(false);
};

const enableCompareView = () => {
    camera.camera.layers = [
        ...DEFAULT_CAMERA_LAYERS,
        compareOriginalLayer.id
    ];
    compareCamera.camera.layers = [
        LAYERID_WORLD,
        LAYERID_IMMEDIATE,
        compareCompressedLayer.id
    ];
    compareCamera.camera.clearColorBuffer = false;
    compareCamera.camera.clearDepthBuffer = true;
    if (compareCamera.camera.camera) {
        compareCamera.camera.camera._scissorRectClear = true;
    }
    compareCamera.enabled = true;
    setCompareUiVisible(true);
    applyCompareSplit(compareSplit);
    syncCompareCameraTransform();
};

const updateCompareLabels = (payload = {}) => {
    const keep = Number(payload.keepPercent ?? keepPercent);
    const origParts = ['原始'];
    const origCount = formatCount(payload.originalCount);
    if (origCount) origParts.push(`${origCount} 点`);
    if (payload.originalSizeBytes != null) origParts.push(formatBytes(payload.originalSizeBytes));
    if (compareLabelLeft) {
        compareLabelLeft.textContent = origParts.join(' · ');
    }
    const compParts = ['压缩后'];
    if (Number.isFinite(keep)) compParts.push(`${keep}%`);
    const compCount = formatCount(payload.compressedCount);
    if (compCount) compParts.push(`${compCount} 点`);
    if (payload.compressedSizeBytes != null) compParts.push(formatBytes(payload.compressedSizeBytes));
    if (compareLabelRight) {
        compareLabelRight.textContent = compParts.join(' · ');
    }
};

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
    syncCompareCameraTransform();
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
    if (isDraggingSplit) return;
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

const unloadGsplatAsset = (entity) => {
    try {
        const assetId = entity?.gsplat?.asset;
        const asset = assetId == null ? null : app.assets.get(assetId);
        if (asset) {
            app.assets.remove(asset);
            asset.unload();
        }
    } catch {
        // ignore engine version differences
    }
};

const LOD_DEBUG_COLORS = [
    '#ff3b30',
    '#34c759',
    '#007aff',
    '#ffcc00',
    '#af52de',
    '#5ac8fa',
    '#ff9500',
    '#8e8e93'
];

const DEBUG_LOD = 1;
const DEBUG_NONE = 0;

const getActiveLodGsplat = () => {
    for (let i = chunkEntities.length - 1; i >= 0; i -= 1) {
        if (chunkEntities[i]?.gsplat) return chunkEntities[i].gsplat;
    }
    return null;
};

const setLodColorize = (enabled) => {
    const gsplatGlobal = app.scene?.gsplat;
    if (!gsplatGlobal) return;
    if (typeof gsplatGlobal.debug !== 'undefined') {
        gsplatGlobal.debug = enabled ? DEBUG_LOD : DEBUG_NONE;
        return;
    }
    if (typeof gsplatGlobal.colorizeLod !== 'undefined') {
        gsplatGlobal.colorizeLod = enabled;
    }
};

const getLodLevelsForDebug = () => {
    const lods = (levelState || [])
        .map((level) => Number(level.lod))
        .filter((lod) => Number.isInteger(lod) && lod >= 0);
    const unique = [...new Set(lods)].sort((a, b) => a - b);
    return unique.length > 0 ? unique : [0, 1, 2, 3, 4, 5];
};

const renderLodColorLegend = () => {
    if (!lodColorLegend) return;
    const lods = getLodLevelsForDebug();
    lodColorLegend.innerHTML = lods.map((lod) => {
        const color = LOD_DEBUG_COLORS[lod % LOD_DEBUG_COLORS.length];
        const hint = lod === 0 ? '近' : lod >= 4 ? '远' : '中';
        return `<span class="inline-flex items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] ring-1 ring-white/10">
            <span class="inline-block h-2 w-2 rounded-full" style="background:${color}"></span>L${lod}${hint}
        </span>`;
    }).join('');
};

const populateLodIsolateSelect = () => {
    if (!lodIsolateSelect) return;
    const current = lodIsolateSelect.value || 'all';
    const lods = getLodLevelsForDebug();
    lodIsolateSelect.innerHTML = '<option value="all">全部（距离流式）</option>'
        + lods.map((lod) => `<option value="${lod}">仅 L${lod}</option>`).join('');
    lodIsolateSelect.value = [...lodIsolateSelect.options].some((opt) => opt.value === current) ? current : 'all';
};

const applyLodDebugSettings = () => {
    const gsplat = getActiveLodGsplat();
    if (!gsplat) return;
    const isolate = lodIsolateSelect?.value || 'all';
    if (isolate === 'all') {
        gsplat.lodRangeMin = 0;
        gsplat.lodRangeMax = 99;
        currentLodEl.textContent = 'ALL';
    } else {
        const lod = Number(isolate);
        gsplat.lodRangeMin = lod;
        gsplat.lodRangeMax = lod;
        currentLodEl.textContent = `L${lod}`;
    }
    if (lodBaseDistanceRange) {
        const dist = Math.max(0.1, Number(lodBaseDistanceRange.value) || 10);
        gsplat.lodBaseDistance = dist;
        if (lodBaseDistanceVal) lodBaseDistanceVal.textContent = String(dist);
    }
    if (lodMultiplierRange) {
        const mult = Math.max(0.1, (Number(lodMultiplierRange.value) || 10) / 10);
        gsplat.lodMultiplier = mult;
        if (lodMultiplierVal) lodMultiplierVal.textContent = mult.toFixed(1);
    }
    setLodColorize(Boolean(lodColorizeToggle?.checked));
};

const setLodDebugUiVisible = (visible) => {
    lodDebugBtn?.classList.toggle('hidden', !visible);
    if (!visible) {
        lodDebugPanel?.classList.add('hidden');
        if (lodColorizeToggle) lodColorizeToggle.checked = false;
        setLodColorize(false);
    } else {
        populateLodIsolateSelect();
        renderLodColorLegend();
        applyLodDebugSettings();
    }
};

const clearCurrentLevelRender = () => {
    setLodDebugUiVisible(false);
    disableCompareView();
    while (chunkEntities.length > 0) {
        const entity = chunkEntities.pop();
        unloadGsplatAsset(entity);
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
        frameCamera = true,
        layers = null,
        cacheKey = ''
    } = options;

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            const bust = `${cacheKey || Date.now()}-${attempt}-${Date.now()}`;
            const cacheBusted = `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(bust)}`;
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
            if (Array.isArray(layers) && layers.length > 0 && entity.gsplat) {
                entity.gsplat.layers = layers.slice();
            }
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
        setViewMode('分层 LOD 流式预览 · lod-meta.json');
        setWorkflowStep(4);
        setStatusPhase('完成', 'ok');
        setProgress('转换完成：已加载完整多层 LOD。可用「LOD 调试」按层级着色查看。', 100);
        setLodDebugUiVisible(true);
        return true;
    } catch (error) {
        setStatusPhase('完成(预览失败)', 'warn');
        setProgress(`最终 lod-meta 加载失败: ${error.message || error}`);
        return false;
    }
};

/**
 * Split-view preview: original on the left, compressed on the right.
 * Both cameras share the same projection; scissor clips without changing aspect.
 */
const loadComparePreview = async (payload) => {
    lastComparePayload = payload || lastComparePayload;
    const data = lastComparePayload || {};
    const originalUrl = data.originalUrl || data.originalPreviewUrl;
    const compressedUrl = data.compressedUrl || data.compressedPreviewUrl;

    clearCurrentLevelRender();
    previewMode = PREVIEW_MODE.compare;
    pipelinePhase = 3;
    currentLodEl.textContent = `${Number(data.keepPercent ?? keepPercent)}%`;
    updateCompareLabels(data);
    setWorkflowStep(4);

    const markSplitSuccess = () => {
        chunkCountEl.textContent = '2';
        loadedChunkCount = 2;
        setStatusPhase('完成', 'ok');
        const keep = Number(data.keepPercent ?? keepPercent);
        const sizeHint = (data.originalSizeBytes != null && data.compressedSizeBytes != null)
            ? ` 体积 ${formatBytes(data.originalSizeBytes)} → ${formatBytes(data.compressedSizeBytes)}。`
            : '';
        setViewMode('对比预览 · 左原始 / 右压缩 · 拖动中线');
        setProgress(`压缩完成：保留 ${keep}%。拖动中间分割线对比效果。${sizeHint}`, 100);
    };

    const markSingleSuccess = (label) => {
        chunkCountEl.textContent = '1';
        loadedChunkCount = 1;
        setStatusPhase('完成', 'ok');
        setViewMode(label);
    };

    const loadSingle = async (url, label) => {
        disableCompareView();
        previewMode = PREVIEW_MODE.compare;
        await loadGsplatUrl(url, {
            name: `compress-single-${Date.now()}`,
            unified: true,
            frameCamera: true,
            retries: 3,
            cacheKey: `${data.keepPercent ?? keepPercent}-${data.compressedSizeBytes ?? Date.now()}`
        });
        markSingleSuccess(label);
    };

    if (!compressedUrl && !originalUrl) {
        setStatusPhase('完成(预览失败)', 'warn');
        setProgress('压缩已完成，但没有可加载的预览地址。');
        return false;
    }

    const canSplit = Boolean(originalUrl && compressedUrl && !data.skipOriginalPreview && !data.skipCompressedPreview);
    const previewCacheKey = [
        data.keepPercent ?? keepPercent,
        data.compressedCount ?? '',
        data.compressedSizeBytes ?? '',
        Date.now()
    ].join('-');

    try {
        if (canSplit) {
            setProgress('正在加载压缩前 / 压缩后对比…');
            enableCompareView();
            await loadGsplatUrl(originalUrl, {
                name: `compare-original-${previewCacheKey}`,
                unified: true,
                layers: [compareOriginalLayer.id],
                frameCamera: true,
                retries: 3,
                cacheKey: `${previewCacheKey}-orig`
            });
            await loadGsplatUrl(compressedUrl, {
                name: `compare-compressed-${previewCacheKey}`,
                unified: true,
                layers: [compareCompressedLayer.id],
                frameCamera: false,
                retries: 3,
                cacheKey: `${previewCacheKey}-cmp`
            });
            markSplitSuccess();
            return true;
        }

        const url = compressedUrl || originalUrl;
        setProgress('文件较大，正在加载单侧预览…');
        await loadSingle(url, compressedUrl ? '压缩结果预览' : '原始模型预览');
        setProgress(
            compressedUrl && data.skipOriginalPreview
                ? '压缩完成。原始文件过大，当前只显示压缩后模型。刷新后若已生成 SOG 预览即可左右对比。'
                : '压缩完成，已加载预览。',
            100
        );
        return true;
    } catch (error) {
        const fallbackUrl = compressedUrl || originalUrl;
        try {
            if (!fallbackUrl) throw error;
            setProgress(`对比加载失败，改为单模型预览：${error.message || error}`);
            await loadSingle(fallbackUrl, '单模型预览');
            setProgress(`未能左右对比（${error.message || error}），已显示压缩结果。`, 100);
            return true;
        } catch (fallbackError) {
            disableCompareView();
            setStatusPhase('完成(预览失败)', 'warn');
            setProgress(`预览失败: ${fallbackError.message || fallbackError}。结果文件仍在输出目录中。`);
            return false;
        }
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
        row.innerHTML = currentMode === WORK_MODE.compress
            ? '<td class="px-2 py-2" colspan="3">暂无压缩任务。开始压缩后会在此显示。</td>'
            : '<td class="px-2 py-2" colspan="3">暂无分块任务。开始转换后会在此显示。</td>';
        taskTableBodyEl.appendChild(row);
    }
    updateTaskSummary();
};

const setUiRunningState = (running) => {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    startBtn.setAttribute('aria-busy', running ? 'true' : 'false');
    const copy = COPY[currentMode] || COPY.lod;
    if (startBtnLabel) {
        startBtnLabel.textContent = running ? copy.startBusy : copy.startIdle;
    }
    if (startBtnSpinner) {
        startBtnSpinner.classList.toggle('hidden', !running);
    }

    const selectors = [
        '#inputPath',
        '#outputRoot',
        '#pickInputBtn',
        '#pickOutputBtn',
        '#downloadOutputBtn',
        '#importPreviewBtn',
        '#lodCount',
        '#chunkCountK',
        '#levelForm input',
        '#inputFileHidden',
        '#keepPercentRange',
        '#keepPercentInput',
        '#modeLodBtn',
        '#modeCompressBtn'
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
    if (!running) {
        refreshOutputDownloads();
    }
};

const setModeSwitchUi = (mode) => {
    const isLod = mode !== WORK_MODE.compress;
    const applyBtn = (btn, active) => {
        if (!btn) return;
        btn.classList.toggle('bg-white', active);
        btn.classList.toggle('text-[#0b5fb9]', active);
        btn.classList.toggle('text-white/85', !active);
        btn.classList.toggle('hover:bg-white/10', !active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    };
    applyBtn(modeLodBtn, isLod);
    applyBtn(modeCompressBtn, !isLod);
};

const syncKeepPercentUi = (value) => {
    const next = clamp(Math.round(Number(value) || 60), 1, 99);
    keepPercent = next;
    if (keepPercentRange && String(keepPercentRange.value) !== String(next)) {
        keepPercentRange.value = String(next);
    }
    if (keepPercentInput && String(keepPercentInput.value) !== String(next)) {
        keepPercentInput.value = String(next);
    }
    if (keepPercentHint) {
        keepPercentHint.textContent = `输出约为原始高斯数量的 ${next}%。例如 ${next}% 即压缩到原来的 ${next}%。`;
    }
    return next;
};

const applyWorkMode = (mode, { syncOutput = true } = {}) => {
    currentMode = mode === WORK_MODE.compress ? WORK_MODE.compress : WORK_MODE.lod;
    const copy = COPY[currentMode];
    setModeSwitchUi(currentMode);
    if (pathDescEl) pathDescEl.innerHTML = currentMode === WORK_MODE.compress
        ? '指定高斯模型与输出目录。按<strong>保留比例</strong>简化为单个 PLY，不生成分层 LOD。'
        : '指定高斯模型与输出目录。流水线为<strong>两段式</strong>（中间 PLY → lod-meta）。';
    if (settingsTitleEl) settingsTitleEl.textContent = copy.settingsTitle;
    if (settingsDescEl) settingsDescEl.textContent = copy.settingsDesc;
    if (convertTitleEl) convertTitleEl.textContent = copy.convertTitle;
    if (convertDescEl) convertDescEl.textContent = copy.convertDesc;
    lodSettingsBlock?.classList.toggle('hidden', currentMode === WORK_MODE.compress);
    compressSettingsBlock?.classList.toggle('hidden', currentMode !== WORK_MODE.compress);
    if (startBtnLabel && startBtn.disabled !== true) {
        startBtnLabel.textContent = copy.startIdle;
    } else if (startBtnLabel && startBtn.disabled) {
        startBtnLabel.textContent = copy.startBusy;
    }
    if (syncOutput && inputPathEl.value.trim()) {
        maybeAutoFillOutput(inputPathEl.value, { force: false });
    }
    if (!activeRunId) {
        setWorkflowStep(inputPathEl.value.trim() && outputRootEl.value.trim() ? 2 : 1);
    }
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
    const folder = currentMode === WORK_MODE.compress
        ? `${sanitizeOutputFolderName(base)}-compressed`
        : sanitizeOutputFolderName(base);
    return `output/${folder}`;
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
        scheduleRefreshOutputDownloads();
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
    scheduleRefreshOutputDownloads();
};

let outputDownloadPrimary = null;
let outputListTimer = null;

const refreshOutputDownloads = async () => {
    if (!outputRootEl) return;
    const root = outputRootEl.value.trim();
    const idle = !activeRunId;
    if (!root) {
        outputDownloadPrimary = null;
        if (downloadOutputBtn) downloadOutputBtn.disabled = true;
        if (importPreviewBtn) importPreviewBtn.disabled = true;
        if (downloadOutputHint) downloadOutputHint.textContent = '已有结果可直接导入预览，不必重新转换';
        return;
    }
    try {
        const res = await fetch(`/api/output-files?root=${encodeURIComponent(root)}`);
        const data = await res.json();
        if (!res.ok) {
            outputDownloadPrimary = null;
            if (downloadOutputBtn) downloadOutputBtn.disabled = true;
            if (importPreviewBtn) importPreviewBtn.disabled = true;
            if (downloadOutputHint) downloadOutputHint.textContent = data.error || '无法读取输出目录';
            return;
        }
        const files = Array.isArray(data.files) ? data.files : [];
        outputDownloadPrimary = data.primary || null;
        const canDownload = Boolean(outputDownloadPrimary) && idle;
        const canPreview = Boolean(data.canPreview) && idle;
        if (downloadOutputBtn) downloadOutputBtn.disabled = !canDownload;
        if (importPreviewBtn) importPreviewBtn.disabled = !canPreview;
        if (!downloadOutputHint) return;
        if (!data.exists) {
            downloadOutputHint.textContent = '输出目录还不存在。转换完成后可导入预览或下载';
            return;
        }
        if (data.kind === 'lod') {
            const levelText = data.lodLevels ? ` · ${data.lodLevels} 层` : '';
            downloadOutputHint.textContent = `检测到 LOD 结果${levelText}，可导入预览`;
            return;
        }
        if (data.kind === 'compress') {
            const keepText = data.keepPercent ? ` · 保留 ${data.keepPercent}%` : '';
            downloadOutputHint.textContent = `检测到压缩结果${keepText}，可导入预览或下载`;
            return;
        }
        if (!outputDownloadPrimary) {
            downloadOutputHint.textContent = '目录已创建，但还没有可预览的结果文件';
            return;
        }
        const primary = files.find((f) => f.name === outputDownloadPrimary);
        const sizeText = primary ? `（${formatBytes(primary.sizeBytes)}）` : '';
        downloadOutputHint.textContent = `可下载 ${outputDownloadPrimary}${sizeText}`;
    } catch (error) {
        outputDownloadPrimary = null;
        if (downloadOutputBtn) downloadOutputBtn.disabled = true;
        if (importPreviewBtn) importPreviewBtn.disabled = true;
        if (downloadOutputHint) downloadOutputHint.textContent = `读取输出目录失败: ${error.message || error}`;
    }
};

const scheduleRefreshOutputDownloads = () => {
    clearTimeout(outputListTimer);
    outputListTimer = setTimeout(() => {
        refreshOutputDownloads();
    }, 250);
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
    if (data.found && data.value) {
        setInputPathValue(data.value, { autoOutput: true, forceOutput: false });
        setProgress(`已选择输入：${data.value}`);
    } else {
        setProgress(data.message || `未找到文件：${fileName}`);
    }
    return data;
};

const fileUrlToPath = (raw) => {
    let text = `${raw ?? ''}`.trim().replace(/^['"]+|['"]+$/g, '');
    if (!text) return '';
    if (/^file:/i.test(text)) {
        try {
            const url = new URL(text);
            let pathname = decodeURIComponent(url.pathname || '');
            if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
            return pathname.replace(/\//g, '\\');
        } catch {
            try {
                const decoded = decodeURIComponent(text.replace(/^file:\/\//i, ''));
                return decoded.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
            } catch {
                return text;
            }
        }
    }
    return text;
};

const pathLooksAbsolute = (value) => {
    const text = `${value ?? ''}`.trim();
    if (!text) return false;
    if (/^[A-Za-z]:[\\/]/.test(text)) return true;
    if (text.startsWith('\\\\') || text.startsWith('/')) return true;
    return false;
};

const collectDroppedPath = (dt, file = null) => {
    if (file?.path && pathLooksAbsolute(file.path)) return file.path;

    const fromUriList = `${dt?.getData?.('text/uri-list') ?? ''}`;
    for (const line of fromUriList.split(/\r?\n/)) {
        const item = line.trim();
        if (!item || item.startsWith('#')) continue;
        const converted = fileUrlToPath(item);
        if (pathLooksAbsolute(converted) || converted.includes('\\') || converted.includes('/')) {
            return converted;
        }
    }

    const plain = `${dt?.getData?.('text/plain') ?? ''}`.trim();
    if (plain) {
        const converted = fileUrlToPath(plain);
        if (pathLooksAbsolute(converted) || converted.includes('\\') || converted.includes('/')) {
            return converted;
        }
    }
    return '';
};

const uploadDroppedFile = async (file) => {
    const name = file.name || 'upload.ply';
    const sizeHint = Number.isFinite(file.size) ? `（${formatBytes(file.size)}）` : '';
    setProgress(`正在导入 ${name}${sizeHint} 到 input/ …`);
    const res = await fetch(`/api/upload-input?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(name)
        },
        body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || '导入文件失败');
    }
    setInputPathValue(data.value, { autoOutput: true, forceOutput: false });
    setProgress(`已导入到 ${data.value}，可开始转换。`);
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
            mode: currentMode,
            keepPercent,
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
    if (cfg.keepPercent != null) {
        syncKeepPercentUi(cfg.keepPercent);
    }
    if (cfg.mode === WORK_MODE.compress || cfg.mode === WORK_MODE.lod) {
        applyWorkMode(cfg.mode, { syncOutput: false });
    }
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
        if (snapshot.mode === WORK_MODE.compress || snapshot.mode === WORK_MODE.lod) {
            applyWorkMode(snapshot.mode, { syncOutput: false });
        }
        if (snapshot.keepPercent != null) {
            syncKeepPercentUi(snapshot.keepPercent);
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
            if (snapshot.mode === WORK_MODE.compress) {
                setStatusPhase('压缩中', 'run');
                setViewMode(fromRefresh ? '已恢复 · 压缩进行中' : '模型压缩');
            } else if (pipelinePhase === 1) {
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
            if (snapshot.mode === WORK_MODE.compress) {
                setViewMode('可加载压缩对比预览');
                if (snapshot.compressedPreviewUrl || snapshot.originalPreviewUrl) {
                    await loadComparePreview({
                        originalUrl: snapshot.originalPreviewUrl,
                        compressedUrl: snapshot.compressedPreviewUrl,
                        keepPercent: snapshot.keepPercent,
                        originalSizeBytes: snapshot.originalSizeBytes,
                        compressedSizeBytes: snapshot.compressedSizeBytes,
                        originalCount: snapshot.originalCount,
                        compressedCount: snapshot.compressedCount,
                        skipOriginalPreview: snapshot.skipOriginalPreview,
                        skipCompressedPreview: snapshot.skipCompressedPreview
                    });
                }
            } else {
                setViewMode('可加载最终 lod-meta');
                if (snapshot.outputMetaUrl) {
                    await loadFinalLodMeta(snapshot.outputMetaUrl);
                }
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
    lastComparePayload = null;
    showingFinalLod = false;
    pipelinePhase = 0;
    previewMode = PREVIEW_MODE.none;
    chunkTasks.clear();
    levelChunkQueue.clear();
    pendingChunkLoads.clear();
    isChunkLoadPumping = false;
    clearCurrentLevelRender();
    if (data.mode === WORK_MODE.compress || data.mode === WORK_MODE.lod) {
        applyWorkMode(data.mode, { syncOutput: false });
    }
    if (data.keepPercent != null) {
        syncKeepPercentUi(data.keepPercent);
    }
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
    if (currentMode === WORK_MODE.compress) {
        setStatusPhase('压缩中', 'run');
        setViewMode('模型压缩');
        setProgress(`压缩已开始：保留 ${keepPercent}% 高斯`, 0);
    } else {
        setStatusPhase('转换中', 'run');
        setViewMode('两段式流水线');
        setProgress('转换已开始：阶段1 简化 → 阶段2 合成 lod-meta', 0);
    }
});

eventSource.addEventListener('phase-start', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    pipelinePhase = Number(data.phase) || 0;
    if (pipelinePhase === 1) {
        if (currentMode === WORK_MODE.compress) {
            setStatusPhase('压缩中', 'run');
            setViewMode('正在简化模型');
            setProgress(data.title || `正在压缩（保留 ${keepPercent}%）…`);
        } else {
            setStatusPhase('阶段1 简化', 'run');
            setViewMode('阶段1 · 生成中间文件');
            setProgress(data.title || '阶段 1：串行生成各层中间简化文件…');
        }
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
        if (currentMode === WORK_MODE.compress) {
            setProgress('压缩完成，准备对比预览…', data.percent ?? 100);
        } else {
            setProgress('阶段1 完成，开始合成 lod-meta…', data.percent ?? null);
        }
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

eventSource.addEventListener('compress-plan', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    const name = data.taskName || '压缩输出';
    setChunkTaskStatus(name, name === '原模型' ? '已计算' : '待计算', name === '原模型' ? 100 : 0);
    renderTaskTable();
});

eventSource.addEventListener('compress-original-ready', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    setChunkTaskStatus(data.taskName || '原模型', '已计算', 100);
    renderTaskTable();
});

eventSource.addEventListener('compress-start', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    pipelinePhase = 1;
    currentLodEl.textContent = `${data.keepPercent ?? keepPercent}%`;
    setChunkTaskStatus(data.taskName || '压缩输出', '正在计算', 5);
    renderTaskTable();
    setViewMode(`压缩中 · 保留 ${data.keepPercent ?? keepPercent}%`);
    setProgress(`正在简化模型（保留 ${data.decimate || `${data.keepPercent}%`}）…`);
});

eventSource.addEventListener('compress-ready', (evt) => {
    const data = JSON.parse(evt.data);
    if (activeRunId && data.runId !== activeRunId) return;
    lastComparePayload = data;
    setChunkTaskStatus('压缩输出', '已计算', 100);
    renderTaskTable();
    currentLodEl.textContent = `${data.keepPercent ?? keepPercent}%`;
    updateCompareLabels(data);
    const sizeLine = (data.originalSizeBytes != null && data.compressedSizeBytes != null)
        ? ` ${formatBytes(data.originalSizeBytes)} → ${formatBytes(data.compressedSizeBytes)}`
        : '';
    setProgress(`压缩结果已写出${sizeLine}，准备对比预览…`);
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
    } else if (currentMode === WORK_MODE.compress && data.percent != null) {
        const task = chunkTasks.get('压缩输出');
        if (task && task.status !== '已计算') {
            setChunkTaskProgress('压缩输出', Math.min(99, Number(data.percent)), '正在计算');
            renderTaskTable();
        }
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

    const outHint = outputRootEl.value.trim() || '输出目录';
    const completedRunId = activeRunId;
    const isCompress = data.mode === WORK_MODE.compress || currentMode === WORK_MODE.compress;

    if (isCompress) {
        const comparePayload = {
            originalUrl: data.originalUrl || lastComparePayload?.originalUrl,
            compressedUrl: data.compressedUrl || lastComparePayload?.compressedUrl,
            keepPercent: data.keepPercent ?? lastComparePayload?.keepPercent ?? keepPercent,
            originalSizeBytes: data.originalSizeBytes ?? lastComparePayload?.originalSizeBytes,
            compressedSizeBytes: data.compressedSizeBytes ?? lastComparePayload?.compressedSizeBytes,
            originalCount: data.originalCount ?? lastComparePayload?.originalCount,
            compressedCount: data.compressedCount ?? lastComparePayload?.compressedCount,
            skipOriginalPreview: data.skipOriginalPreview ?? false,
            skipCompressedPreview: data.skipCompressedPreview ?? false
        };
        lastComparePayload = comparePayload;
        setProgress(`压缩完成，正在加载对比预览… 输出：${outHint}`, 100);
        const loaded = await loadComparePreview(comparePayload);
        if (activeRunId === completedRunId) {
            activeRunId = null;
        }
        refreshOutputDownloads();
        if (!loaded) {
            setStatusPhase('完成(预览失败)', 'warn');
        }
        return;
    }

    const metaUrl = data.outputMetaUrl || finalLodMetaUrl;
    finalLodMetaUrl = metaUrl;
    setProgress(`计算完成，正在加载分层结果… 输出：${outHint}`, 100);

    // Keep runId until final load finishes so late chunk-ready events still match
    const loaded = await loadFinalLodMeta(metaUrl);
    if (activeRunId === completedRunId) {
        activeRunId = null;
    }
    refreshOutputDownloads();
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
    refreshOutputDownloads();
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
    refreshOutputDownloads();
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
    syncKeepPercentUi(defaults.keepPercent || 60);
    applyWorkMode(defaults.mode === WORK_MODE.compress ? WORK_MODE.compress : WORK_MODE.lod, { syncOutput: false });
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
    refreshOutputDownloads();
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

    if (currentMode === WORK_MODE.compress) {
        const keep = syncKeepPercentUi(keepPercentInput?.value || keepPercentRange?.value || keepPercent);
        if (keep < 1 || keep > 99) {
            setProgress('保留比例需在 1%–99% 之间。');
            setWorkflowStep(2);
            setStatusPhase('参数无效', 'warn');
            return null;
        }
        return {
            mode: WORK_MODE.compress,
            inputPath,
            outputRoot,
            keepPercent: keep,
            resume: true
        };
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
        mode: WORK_MODE.lod,
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
    setUiRunningState(true);
    setStatusPhase('启动中', 'run');
    setProgress(currentMode === WORK_MODE.compress ? '正在启动压缩…' : '正在启动转换…', 0);

    try {
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
    } catch (error) {
        setUiRunningState(false);
        setWorkflowStep(2);
        setStatusPhase('启动失败', 'err');
        setProgress(`启动失败: ${error.message || error}`);
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
            scheduleRefreshOutputDownloads();
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
    scheduleRefreshOutputDownloads();
});

inputPathEl.addEventListener('change', () => {
    updateInputDropHint(inputPathEl.value);
    maybeAutoFillOutput(inputPathEl.value, { force: false });
    saveConfigToStorage();
});
outputRootEl.addEventListener('change', () => {
    saveConfigToStorage();
    scheduleRefreshOutputDownloads();
});

const importExistingOutput = async () => {
    if (activeRunId) {
        setProgress('请先等待当前任务结束，再导入预览。');
        return;
    }
    const root = outputRootEl.value.trim();
    if (!root) {
        setProgress('请先填写或选择已有输出目录。');
        setWorkflowStep(1);
        return;
    }

    setStatusPhase('导入中', 'run');
    setProgress('正在导入已有结果…');
    if (importPreviewBtn) importPreviewBtn.disabled = true;

    try {
        const res = await fetch('/api/open-output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputRoot: root })
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || '导入失败');
        }

        if (data.kind === 'lod') {
            applyWorkMode(WORK_MODE.lod, { syncOutput: false });
            if (Number(data.lodLevels) > 0) {
                rebuildLevelsByCount(Number(data.lodLevels));
            }
            setWorkflowStep(4);
            const loaded = await loadFinalLodMeta(data.outputMetaUrl);
            if (loaded) {
                setProgress(`已导入 LOD 预览：${root}`, 100);
            }
            return;
        }

        if (data.kind === 'compress') {
            applyWorkMode(WORK_MODE.compress, { syncOutput: false });
            if (data.keepPercent != null) syncKeepPercentUi(data.keepPercent);
            setWorkflowStep(4);
            const loaded = await loadComparePreview(data);
            if (loaded) {
                setProgress(`已导入压缩对比预览：${root}`, 100);
            }
            return;
        }

        throw new Error('未识别的输出类型。');
    } catch (error) {
        setStatusPhase('导入失败', 'err');
        setProgress(`导入预览失败: ${error.message || error}`);
    } finally {
        refreshOutputDownloads();
    }
};

if (importPreviewBtn) {
    importPreviewBtn.addEventListener('click', () => {
        importExistingOutput();
    });
}

if (downloadOutputBtn) {
    downloadOutputBtn.addEventListener('click', () => {
        const root = outputRootEl.value.trim();
        if (!root || !outputDownloadPrimary) {
            setProgress('还没有可下载的结果文件。');
            return;
        }
        const url = `/api/download-output?root=${encodeURIComponent(root)}&name=${encodeURIComponent(outputDownloadPrimary)}`;
        const link = document.createElement('a');
        link.href = url;
        link.download = outputDownloadPrimary;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setProgress(`开始下载 ${outputDownloadPrimary}…`);
    });
}

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

const handleDroppedFile = async (file, dt = null) => {
    if (!file) return;
    const name = file.name || '';
    if (!isAcceptedInputName(name)) {
        setProgress(`不支持的文件类型：${name || '(未知)'}，请使用 .ply / .sog 等`);
        return;
    }

    try {
        const realPath = collectDroppedPath(dt, file);
        if (realPath) {
            const data = await resolveDroppedInput(name, realPath);
            if (data.found && data.value) {
                setInputPathValue(data.value, { autoOutput: true, forceOutput: false });
                setProgress(`已选择输入：${data.value}`);
                return;
            }
        }
        // Browser did not expose a usable OS path: copy into workspace input/
        await uploadDroppedFile(file);
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

        const file = dt.files?.[0];
        if (file) {
            await handleDroppedFile(file, dt);
            return;
        }

        const droppedPath = collectDroppedPath(dt, null);
        if (droppedPath) {
            const base = basenameFromPath(droppedPath);
            try {
                await applyResolvedInput(base || droppedPath, droppedPath);
            } catch (error) {
                setProgress(`导入失败: ${error.message || error}`);
            }
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

const onKeepPercentChange = (value) => {
    syncKeepPercentUi(value);
    if (!activeRunId) setWorkflowStep(2);
    saveConfigToStorage();
};

if (keepPercentRange) {
    keepPercentRange.addEventListener('input', () => onKeepPercentChange(keepPercentRange.value));
}
if (keepPercentInput) {
    keepPercentInput.addEventListener('input', () => onKeepPercentChange(keepPercentInput.value));
    keepPercentInput.addEventListener('keydown', (e) => {
        if (e.key === 'e' || e.key === 'E' || e.key === '+' || e.key === '-') {
            e.preventDefault();
        }
    });
}

const setWorkModeFromUi = (mode) => {
    if (activeRunId) return;
    if (mode === currentMode) return;
    applyWorkMode(mode, { syncOutput: true });
    saveConfigToStorage();
    setProgress(currentMode === WORK_MODE.compress
        ? '已切换到模型压缩：设置保留比例后开始压缩。'
        : '已切换到 LOD 转换：设置层数与保留率后开始转换。');
    setStatusPhase('就绪', 'idle');
};

if (modeLodBtn) {
    modeLodBtn.addEventListener('click', () => setWorkModeFromUi(WORK_MODE.lod));
}
if (modeCompressBtn) {
    modeCompressBtn.addEventListener('click', () => setWorkModeFromUi(WORK_MODE.compress));
}

const previewSectionEl = canvas?.closest('section') || canvas?.parentElement;

const splitFromClientX = (clientX) => {
    const rect = (previewSectionEl || canvas).getBoundingClientRect();
    if (!rect.width) return compareSplit;
    return (clientX - rect.left) / rect.width;
};

if (compareDivider) {
    compareDivider.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDraggingSplit = true;
        isLeftDown = false;
        isRightDown = false;
        compareDivider.setPointerCapture(e.pointerId);
        applyCompareSplit(splitFromClientX(e.clientX));
    });
    compareDivider.addEventListener('pointermove', (e) => {
        if (!isDraggingSplit) return;
        applyCompareSplit(splitFromClientX(e.clientX));
    });
    const endSplitDrag = (e) => {
        if (!isDraggingSplit) return;
        isDraggingSplit = false;
        try {
            compareDivider.releasePointerCapture(e.pointerId);
        } catch {
            // already released
        }
    };
    compareDivider.addEventListener('pointerup', endSplitDrag);
    compareDivider.addEventListener('pointercancel', endSplitDrag);
}

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

if (lodDebugBtn && lodDebugPanel) {
    lodDebugBtn.addEventListener('click', () => {
        const willShow = lodDebugPanel.classList.contains('hidden');
        lodDebugPanel.classList.toggle('hidden', !willShow);
        if (willShow) {
            populateLodIsolateSelect();
            renderLodColorLegend();
            applyLodDebugSettings();
        }
    });
}
if (lodColorizeToggle) {
    lodColorizeToggle.addEventListener('change', () => {
        applyLodDebugSettings();
        setProgress(lodColorizeToggle.checked
            ? '已开启 LOD 层级着色。不同颜色对应不同层。'
            : '已关闭层级着色，恢复真实颜色。');
    });
}
if (lodIsolateSelect) {
    lodIsolateSelect.addEventListener('change', () => {
        applyLodDebugSettings();
        const v = lodIsolateSelect.value;
        setProgress(v === 'all' ? '显示全部 LOD（按距离自动切换）。' : `仅显示 L${v}。`);
    });
}
if (lodBaseDistanceRange) {
    lodBaseDistanceRange.addEventListener('input', applyLodDebugSettings);
}
if (lodMultiplierRange) {
    lodMultiplierRange.addEventListener('input', applyLodDebugSettings);
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
