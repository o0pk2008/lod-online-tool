// Planning uses sampled L0 centers. Simplified LOD positions and Gaussian extents
// only exist after conversion, so these are explicitly approximate spatial boxes.
export function planChunks(positions, totalCount, chunkCountK, chunkExtent, lodWeight = 1, maxBoxes = 2048) {
    const indices = [];
    for (let i = 0; i < positions.length / 3; i++) {
        if ([0, 1, 2].every(a => Number.isFinite(positions[i * 3 + a]))) indices.push(i);
    }
    if (!indices.length) return { boxes: [], limited: false };
    const weight = totalCount * lodWeight / indices.length;
    const boxes = [];
    let limited = false;
    const visit = (ids, budget) => {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const i of ids) for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], positions[i * 3 + a]);
            max[a] = Math.max(max[a], positions[i * 3 + a]);
        }
        const spans = max.map((v, a) => v - min[a]);
        const axis = spans.indexOf(Math.max(...spans));
        const split = ids.length > 1 && ids.length * weight > 256 &&
            (ids.length * weight > chunkCountK * 1024 || spans[axis] > chunkExtent);
        if (split && budget > 1) {
            ids.sort((a, b) => positions[a * 3 + axis] - positions[b * 3 + axis]);
            const mid = ids.length >>> 1;
            visit(ids.slice(0, mid), Math.floor(budget / 2));
            visit(ids.slice(mid), Math.ceil(budget / 2));
        } else {
            limited ||= split;
            boxes.push({ min, max });
        }
    };
    visit(indices, maxBoxes);
    return { boxes, limited };
}
