// Matches PlayCanvas 2.21.3 distance LOD selection (45 degree reference FOV).
export const normalizeLodSettings = (base, multiplier) => ({
    base: Math.min(1e6, Math.max(0.1, Number(base) || 10)),
    multiplier: Math.min(8, Math.max(1.2, Number(multiplier) || 3))
});

export const lodThresholds = (base, multiplier, levels) => {
    const settings = normalizeLodSettings(base, multiplier);
    return Array.from({ length: Math.max(0, levels - 1) }, (_, i) => settings.base * settings.multiplier ** i);
};

export const distanceLod = (distance, thresholds) => {
    let lod = 0;
    while (lod < thresholds.length && distance >= thresholds[lod]) lod++;
    return lod;
};

export const lodFovScale = (fov, aspect, horizontal = false) => {
    const vertical = Math.tan(fov * Math.PI / 360) / (horizontal ? aspect : 1);
    return Math.min(vertical, vertical * aspect) / Math.tan(Math.PI / 8);
};

export const pointBoxDistance = (point, min, max) => Math.hypot(
    ...point.map((v, i) => Math.max(min[i] - v, 0, v - max[i]))
);

export const fitLodBase = (distance, levels, multiplier = 3) => {
    const middle = Math.max(1, Math.floor(levels / 2));
    return normalizeLodSettings(distance / multiplier ** (middle - 0.5), multiplier).base;
};
