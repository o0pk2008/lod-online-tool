import { planChunks } from './chunk-plan.js';
let positions, totalCount;
self.onmessage = ({ data }) => {
    if (data.positions) {
        positions = data.positions;
        totalCount = data.totalCount;
        return;
    }
    if (!positions) return;
    self.postMessage({ id: data.id, ...planChunks(positions, totalCount, data.chunkCountK, data.chunkExtent, data.lodWeight) });
};
