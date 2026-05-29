// 기존 영상 HLS 재생성 (1회성 마이그레이션).
// HEVC/4K/고비트레이트 영상의 HLS만 H.264 1080p로 다시 만든다.
// 원본 파일과 DB는 절대 건드리지 않는다. 이미 스트리밍 가능한 영상은 건너뛴다.
// 실행: docker exec <container> node dist/server/retranscode.js
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { regenerateHls, probeVideo, needsTranscode } from './media-processor.js';

const dataDir = path.resolve('data');

// 이미 H.264로 완전히 트랜스코딩된 HLS인지 (재개용: 완료된 건 건너뜀).
// playlist에 #EXT-X-ENDLIST(완결 표시)가 있고 init이 h264여야 완료로 본다.
function alreadyDone(filename: string): boolean {
  const dir = path.join(dataDir, 'hls', filename);
  const playlist = path.join(dir, 'playlist.m3u8');
  const init = path.join(dir, 'init.mp4');
  if (!fs.existsSync(playlist) || !fs.existsSync(init)) return false;
  try {
    if (!fs.readFileSync(playlist, 'utf8').includes('#EXT-X-ENDLIST')) return false;
    const codec = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', init,
    ]).toString().trim();
    return codec === 'h264';
  } catch {
    return false;
  }
}
const dbFile = fs.readdirSync(dataDir).find(f => f.endsWith('.db'));
if (!dbFile) {
  console.error('[retranscode] data 폴더에서 .db 파일을 찾지 못함');
  process.exit(1);
}
const db = new Database(path.join(dataDir, dbFile), { readonly: true });

const vids = db.prepare(
  "SELECT id, filename, originalName FROM media WHERE type='video' AND (source IS NULL OR source='local') ORDER BY id"
).all() as Array<{ id: number; filename: string; originalName: string }>;

console.log(`[retranscode] DB=${dbFile} | 영상 ${vids.length}개 검사 시작`);

let transcoded = 0, skipped = 0, resumed = 0, failed = 0;
for (const v of vids) {
  const orig = path.join(dataDir, 'originals', v.filename);
  if (!fs.existsSync(orig)) { skipped++; continue; }
  try {
    const info = await probeVideo(orig);
    if (!needsTranscode(info)) { skipped++; continue; } // 이미 스트리밍 가능 → 기존 HLS 유지
    if (alreadyDone(v.filename)) { resumed++; continue; } // 이미 H.264로 끝남 → 재개 시 건너뜀
    const t0 = Date.now();
    await regenerateHls(v.filename);
    transcoded++;
    console.log(`[retranscode] (${transcoded}) ${v.originalName} | ${info.width}x${info.height} ${info.codec} | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    failed++;
    console.error(`[retranscode] 실패: ${v.originalName} →`, e instanceof Error ? e.message : e);
  }
}

console.log(`[retranscode] 완료. 트랜스코딩=${transcoded} 이미완료=${resumed} 건너뜀=${skipped} 실패=${failed}`);
db.close();
