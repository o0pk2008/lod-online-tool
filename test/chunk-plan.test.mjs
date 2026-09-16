import test from 'node:test';
import assert from 'node:assert/strict';
import { planChunks } from '../public/chunk-plan.js';

const points = Float32Array.from(Array.from({ length: 4096 }, (_, i) => [i / 128, (i % 16) / 4, 2]).flat());
test('point limit and spatial span independently refine planning boxes', () => {
    const coarse = planChunks(points, 4096, 512, 100);
    const count = planChunks(points, 4096, 1, 100);
    const spatial = planChunks(points, 4096, 512, 4);
    assert.equal(coarse.boxes.length, 1);
    assert.equal(count.boxes.length, 4);
    assert.ok(spatial.boxes.length > 1);
    for (const box of spatial.boxes) assert.ok(box.max[0] - box.min[0] <= 4);
    assert.ok(planChunks(points, 4096, 1, 100, 3).boxes.length > count.boxes.length);
});
test('all valid centers are covered, including offset and degenerate axes', () => {
    const result = planChunks(points, 4096, 1, 4);
    for (let i = 0; i < points.length; i += 3) {
        assert.ok(result.boxes.some(b => [0, 1, 2].every(a => points[i + a] >= b.min[a] && points[i + a] <= b.max[a])));
    }
});
test('invalid points and preview budget are bounded', () => {
    assert.deepEqual(planChunks(new Float32Array([NaN, 0, 0]), 1, 1, 16).boxes, []);
    const result = planChunks(points, 1e7, 1, 1, 1, 16);
    assert.equal(result.boxes.length, 16);
    assert.equal(result.limited, true);
});
