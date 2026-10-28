import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('in-flight and queued duplicates are rejected; completion and failure release the hash', async () => {
  // 실제 큐를 번들하되 NAS/DB/알림에 닿지 않게 처리 완료 시점만 제어한다.
  const result = await build({
    stdin: { contents: "export * from './server/upload-queue.ts'; export { waiting } from './server/media-processor.js';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'queue-fixtures', setup(build) {
      build.onResolve({ filter: /\/(media-processor|push|db)\.js$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
        args.path.includes('media-processor') ? `
          export const waiting = new Map();
          export const processImage = filename => new Promise((resolve, reject) => waiting.set(filename, {resolve, reject}));
          export const processVideo = processImage;
        ` : args.path.includes('push') ? 'export const sendPushToOthers = () => {};' : `
          export default { prepare: () => ({ run: () => {}, get: () => ({name: 'test'}) }) };
        `, loader: 'js' }));
    }}],
  });
  const code = result.outputFiles[0].text;
  const queue = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const item = (filename, hash) => ({ filename, originalName: filename, mimeType: 'video/mp4', type: 'video', size: 1, uploaderId: 1, hash });
  assert.equal(queue.enqueue(item('first.mp4', 'a')), true);
  assert.equal(queue.hasPendingHash('a'), true);
  assert.equal(queue.enqueue(item('duplicate.mp4', 'a')), false);
  assert.equal(queue.enqueue(item('second.mp4', 'b')), true);
  assert.equal(queue.hasPendingHash('b'), true);
  assert.equal(queue.enqueue(item('duplicate-b.mp4', 'b')), false);
  assert.deepEqual(queue.getQueueStatus().queue.map(r => r.filename), ['second.mp4']);
  queue.waiting.get('first.mp4').resolve({ width: 1, height: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.hasPendingHash('a'), false);
  assert.equal(queue.getQueueStatus().current.filename, 'second.mp4');
  assert.equal(queue.hasPendingHash('b'), true);
  queue.waiting.get('second.mp4').reject(new Error('expected processing failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.hasPendingHash('b'), false);
  assert.equal(queue.enqueue(item('retry.mp4', 'b')), true);
  queue.waiting.get('retry.mp4').resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.getQueueStatus().current, null);
});
