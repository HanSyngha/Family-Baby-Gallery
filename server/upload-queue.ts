import { processImage, processVideo } from './media-processor.js';
import { sendPushToOthers } from './push.js';
import db from './db.js';

interface QueueItem {
  filename: string;
  originalName: string;
  mimeType: string;
  type: 'image' | 'video';
  size: number;
  uploaderId: number;
  hash: string;
}

interface RecentResult {
  filename: string;
  originalName: string;
  status: 'done' | 'error';
  error?: string;
  elapsed: number;
}

const queue: QueueItem[] = [];
let processing = false;
let current: { filename: string; originalName: string; startedAt: number } | null = null;
const recentResults: RecentResult[] = [];
const MAX_RECENT = 20;

export function getQueueStatus() {
  return {
    current,
    queue: queue.map(q => ({ filename: q.filename, originalName: q.originalName })),
    recentResults,
  };
}

export function enqueue(item: QueueItem) {
  queue.push(item);
  console.log(`[Queue] Added: ${item.originalName} (${(item.size / 1024 / 1024).toFixed(1)}MB) | queue size: ${queue.length}`);
  processNext();
}

async function processNext() {
  if (processing || queue.length === 0) return;
  processing = true;

  const item = queue.shift()!;
  const start = Date.now();
  current = { filename: item.filename, originalName: item.originalName, startedAt: start };
  console.log(`[Queue] Processing: ${item.originalName} (${item.type})`);

  try {
    const result = item.type === 'image'
      ? await processImage(item.filename)
      : await processVideo(item.filename);

    const elapsedSec = (Date.now() - start) / 1000;
    console.log(`[Queue] Processed: ${item.originalName} in ${elapsedSec.toFixed(1)}s | ${result.width}x${result.height} | takenAt: ${result.takenAt || 'none'}`);

    const nowKst = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO media (uploaderId, filename, originalName, mimeType, type, size, width, height, duration, hash, createdAt, uploadedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.uploaderId,
      item.filename,
      item.originalName,
      item.mimeType,
      item.type,
      item.size,
      result.width ?? null,
      result.height ?? null,
      result.duration ?? null,
      item.hash,
      result.takenAt ?? nowKst,
      nowKst,
    );

    console.log(`[Queue] DB inserted: ${item.originalName} | remaining: ${queue.length}`);

    recentResults.push({ filename: item.filename, originalName: item.originalName, status: 'done', elapsed: elapsedSec });
    if (recentResults.length > MAX_RECENT) recentResults.shift();

    const uploader = db.prepare('SELECT name FROM users WHERE id = ?').get(item.uploaderId) as any;
    const uploaderName = uploader?.name || '누군가';
    const typeLabel = item.type === 'image' ? '사진' : '영상';
    sendPushToOthers(item.uploaderId, `${uploaderName}님의 새로운 ${typeLabel}`, `${uploaderName}님이 올리신 새로운 땅콩땅콩 ${typeLabel}을 확인하세요! 🥜`);
  } catch (err) {
    const elapsed = (Date.now() - start) / 1000;
    const errMsg = err instanceof Error ? err.message : String(err);
    recentResults.push({ filename: item.filename, originalName: item.originalName, status: 'error', error: errMsg, elapsed });
    if (recentResults.length > MAX_RECENT) recentResults.shift();
    console.error(`[Queue] FAILED: ${item.originalName}`, err);
  }

  current = null;
  processing = false;
  processNext();
}
