import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLodSettings, lodThresholds, distanceLod, lodFovScale, pointBoxDistance, fitLodBase } from '../public/lod-debug.js';

test('controls honor engine limits and each threshold selects the next LOD', () => {
    assert.equal(normalizeLodSettings(0.01, 0.1).multiplier, 1.2);
    assert.equal(normalizeLodSettings(0.01, 0.1).base, 0.1);
    const thresholds = lodThresholds(10, 3, 4);
    assert.deepEqual(thresholds, [10, 30, 90]);
    assert.deepEqual([0, 9.99, 10, 29.99, 30, 90, 1e6].map(d => distanceLod(d, thresholds)), [0, 0, 1, 1, 2, 3, 3]);
    assert.equal(distanceLod(1e6, lodThresholds(10, 3, 1)), 0);
});

test('distance is to the nearest box surface and accounts for a narrow viewport', () => {
    assert.equal(pointBoxDistance([0, 0, 0], [-2, -2, -2], [2, 2, 2]), 0);
    assert.equal(pointBoxDistance([5, 6, 2], [-2, -2, -2], [2, 2, 2]), 5);
    assert.ok(Math.abs(lodFovScale(45, 1) - 1) < 1e-9);
    assert.ok(Math.abs(lodFovScale(45, 0.25) - 0.25) < 1e-9);
});

test('fitting works for small and large models instead of saturating at the coarsest layer', () => {
    for (const distance of [1, 100, 10000]) {
        const thresholds = lodThresholds(fitLodBase(distance, 6), 3, 6);
        assert.equal(distanceLod(distance, thresholds), 3);
        assert.equal(distanceLod(distance / 100, thresholds), 0);
        assert.equal(distanceLod(distance * 100, thresholds), 5);
    }
});
