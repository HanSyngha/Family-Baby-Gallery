import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { enqueue, getQueueStatus } from '../upload-queue.js';
import db, { familyDb } from '../db.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { ensureDerivative, parseDerivativeWidth } from '../derivatives.js';

const DATA_DIR = path.resolve('data');

function resolveDataDir(source: string | null): string {
  return source === 'family'
    ? (process.env.FAMILY_DATA_DIR || '/app/data-family')
    : DATA_DIR;
}

function parseVideoCursor(cursor?: string): { createdAt: string; id: number | null } | null {
  if (!cursor) return null;
  const [createdAt, id] = cursor.split('|');
  return { createdAt, id: id ? parseInt(id) : null };
}

function makeVideoCursor(row: any): string {
  return `${row.createdAt}|${row.id}`;
}

export function registerMediaRoutes(app: FastifyInstance) {
  // 미디어 목록 (커서 기반 페이지네이션, sort 지원)
  app.get('/api/media', { preHandler: authenticate }, async (request) => {
    const { cursor, limit = '20', sort = 'recent' } = request.query as { cursor?: string; limit?: string; sort?: string };
    const lim = Math.min(parseInt(limit), 50);
    const { userId, role } = (request as any).user;

    const baseQuery = `
      SELECT m.*,
        u.name as uploaderName, u.profileImage as uploaderImage,
        (SELECT COUNT(*) FROM likes WHERE mediaId = m.id) as likeCount,
        (SELECT COUNT(*) FROM comments WHERE mediaId = m.id) as commentCount,
        (SELECT COUNT(*) FROM views WHERE mediaId = m.id) as viewCount,
        (SELECT COUNT(*) FROM shares WHERE mediaId = m.id) as shareCount,
        EXISTS(SELECT 1 FROM likes WHERE mediaId = m.id AND userId = ?) as liked,
        EXISTS(SELECT 1 FROM favorites WHERE mediaId = m.id AND userId = ?) as favorited,
        (SELECT json_group_array(json_object('userId', vu.id, 'name', vu.name, 'profileImage', vu.profileImage))
         FROM (SELECT DISTINCT vw.userId FROM views vw WHERE vw.mediaId = m.id) dv JOIN users vu ON vu.id = dv.userId) as viewersJson,
        (SELECT json_group_array(json_object('userId', du.id, 'name', du.name, 'profileImage', du.profileImage))
         FROM downloads dl JOIN users du ON du.id = dl.userId WHERE dl.mediaId = m.id) as downloadersJson
      FROM media m
      JOIN users u ON u.id = m.uploaderId
    `;

    let rows: any[];
    if (sort === 'likes') {
      rows = db.prepare(baseQuery + ' ORDER BY likeCount DESC, m.id DESC').all(userId, userId);
    } else if (sort === 'views') {
      rows = db.prepare(baseQuery + ' ORDER BY (SELECT COUNT(*) FROM views WHERE mediaId = m.id) DESC, m.id DESC').all(userId, userId);
    } else if (sort === 'favorites') {
      rows = db.prepare(baseQuery + ' WHERE EXISTS(SELECT 1 FROM favorites WHERE mediaId = m.id AND userId = ?) ORDER BY m.createdAt DESC').all(userId, userId, userId);
    } else if (cursor) {
      // 커서는 'createdAt|id' 복합키. id 없는 옛 커서(날짜 점프 등)는 createdAt만으로 비교.
      const c = parseVideoCursor(cursor)!;
      rows = c.id !== null && !Number.isNaN(c.id)
        ? db.prepare(baseQuery + ' WHERE (m.createdAt < ? OR (m.createdAt = ? AND m.id < ?)) ORDER BY m.createdAt DESC, m.id DESC LIMIT ?').all(userId, userId, c.createdAt, c.createdAt, c.id, lim)
        : db.prepare(baseQuery + ' WHERE m.createdAt < ? ORDER BY m.createdAt DESC, m.id DESC LIMIT ?').all(userId, userId, c.createdAt, lim);
    } else {
      rows = db.prepare(baseQuery + ' ORDER BY m.createdAt DESC, m.id DESC LIMIT ?').all(userId, userId, lim);
    }

    const isMaster = role === 'master';
    const items = rows.map(row => {
      const viewers = isMaster && row.viewersJson ? JSON.parse(row.viewersJson).filter((v: any) => v.userId !== null) : [];
      const downloaders = isMaster && row.downloadersJson ? JSON.parse(row.downloadersJson).filter((d: any) => d.userId !== null) : [];
      const { viewersJson, downloadersJson, ...rest } = row;
      return { ...rest, viewCount: row.viewCount || 0, shareCount: row.shareCount || 0, liked: !!row.liked, favorited: !!row.favorited, viewers, downloaders };
    });

    const noPagination = sort === 'likes' || sort === 'views' || sort === 'favorites';
    const nextCursor = noPagination ? null : (rows.length === lim ? makeVideoCursor(rows[rows.length - 1]) : null);
    return { items, nextCursor };
  });

  // 쇼츠형 영상 피드: 전체 갤러리 목록과 분리해 영상만 가볍게 페이지네이션한다.
  app.get('/api/media/videos', { preHandler: authenticate }, async (request) => {
    const { cursor, limit = '12' } = request.query as { cursor?: string; limit?: string };
    const lim = Math.min(Math.max(parseInt(limit) || 12, 1), 24);
    const { userId, role } = (request as any).user;

    const baseQuery = `
      SELECT m.*,
        u.name as uploaderName, u.profileImage as uploaderImage,
        (SELECT COUNT(*) FROM likes WHERE mediaId = m.id) as likeCount,
        (SELECT COUNT(*) FROM comments WHERE mediaId = m.id) as commentCount,
        (SELECT COUNT(*) FROM views WHERE mediaId = m.id) as viewCount,
        (SELECT COUNT(*) FROM shares WHERE mediaId = m.id) as shareCount,
        EXISTS(SELECT 1 FROM likes WHERE mediaId = m.id AND userId = ?) as liked,
        EXISTS(SELECT 1 FROM favorites WHERE mediaId = m.id AND userId = ?) as favorited,
        (SELECT json_group_array(json_object('userId', vu.id, 'name', vu.name, 'profileImage', vu.profileImage))
         FROM (SELECT DISTINCT vw.userId FROM views vw WHERE vw.mediaId = m.id) dv JOIN users vu ON vu.id = dv.userId) as viewersJson,
        (SELECT json_group_array(json_object('userId', du.id, 'name', du.name, 'profileImage', du.profileImage))
         FROM downloads dl JOIN users du ON du.id = dl.userId WHERE dl.mediaId = m.id) as downloadersJson
      FROM media m
      JOIN users u ON u.id = m.uploaderId
      WHERE m.type = 'video'
    `;

    const parsedCursor = parseVideoCursor(cursor);
    let rows: any[];
    if (parsedCursor?.id) {
      rows = db.prepare(baseQuery + ' AND (m.createdAt < ? OR (m.createdAt = ? AND m.id < ?)) ORDER BY m.createdAt DESC, m.id DESC LIMIT ?')
        .all(userId, userId, parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id, lim);
    } else if (parsedCursor) {
      rows = db.prepare(baseQuery + ' AND m.createdAt < ? ORDER BY m.createdAt DESC, m.id DESC LIMIT ?')
        .all(userId, userId, parsedCursor.createdAt, lim);
    } else {
      rows = db.prepare(baseQuery + ' ORDER BY m.createdAt DESC, m.id DESC LIMIT ?').all(userId, userId, lim);
    }

    const isMaster = role === 'master';
    const items = rows.map((row: any) => {
      const viewers = isMaster && row.viewersJson ? JSON.parse(row.viewersJson).filter((v: any) => v.userId !== null) : [];
      const downloaders = isMaster && row.downloadersJson ? JSON.parse(row.downloadersJson).filter((d: any) => d.userId !== null) : [];
      const { viewersJson, downloadersJson, ...rest } = row;
      return { ...rest, viewCount: row.viewCount || 0, shareCount: row.shareCount || 0, liked: !!row.liked, favorited: !!row.favorited, viewers, downloaders };
    });

    return { items, nextCursor: rows.length === lim ? makeVideoCursor(rows[rows.length - 1]) : null };
  });

  // 전체 미디어 ID 목록 (랜덤 재생용, 가벼움)
  app.get('/api/media/ids', { preHandler: authenticate }, async () => {
    const rows = db.prepare('SELECT id, filename, type, createdAt FROM media ORDER BY createdAt DESC').all();
    return { items: rows };
  });

  // 단일 미디어 상세
  app.get('/api/media/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId, role } = (request as any).user;

    const row = db.prepare(`
      SELECT m.*,
        u.name as uploaderName, u.profileImage as uploaderImage,
        (SELECT COUNT(*) FROM likes WHERE mediaId = m.id) as likeCount,
        (SELECT COUNT(*) FROM comments WHERE mediaId = m.id) as commentCount,
        (SELECT COUNT(*) FROM views WHERE mediaId = m.id) as viewCount,
        (SELECT COUNT(*) FROM shares WHERE mediaId = m.id) as shareCount,
        EXISTS(SELECT 1 FROM likes WHERE mediaId = m.id AND userId = ?) as liked,
        EXISTS(SELECT 1 FROM favorites WHERE mediaId = m.id AND userId = ?) as favorited,
        (SELECT json_group_array(json_object('userId', vu.id, 'name', vu.name, 'profileImage', vu.profileImage))
         FROM (SELECT DISTINCT vw.userId FROM views vw WHERE vw.mediaId = m.id) dv JOIN users vu ON vu.id = dv.userId) as viewersJson,
        (SELECT json_group_array(json_object('userId', du.id, 'name', du.name, 'profileImage', du.profileImage))
         FROM downloads dl JOIN users du ON du.id = dl.userId WHERE dl.mediaId = m.id) as downloadersJson
      FROM media m
      JOIN users u ON u.id = m.uploaderId
      WHERE m.id = ?
    `).get(userId, userId, parseInt(id)) as any;

    if (!row) return reply.code(404).send({ error: 'Not found' });

    const isMaster = role === 'master';
    const viewers = isMaster && row.viewersJson ? JSON.parse(row.viewersJson).filter((v: any) => v.userId !== null) : [];
    const downloaders = isMaster && row.downloadersJson ? JSON.parse(row.downloadersJson).filter((d: any) => d.userId !== null) : [];
    const { viewersJson, downloadersJson, ...rest } = row;
    return { ...rest, viewCount: row.viewCount || 0, liked: !!row.liked, favorited: !!row.favorited, viewers, downloaders };
  });

  // 업로드 전 중복 체크 (해시)
  app.post('/api/media/check-duplicate', { preHandler: authenticate }, async (request) => {
    const { hash } = request.body as { hash: string };
    if (!hash) return { duplicate: false };
    const existing = db.prepare('SELECT id FROM media WHERE hash = ?').get(hash) as any;
    return { duplicate: !!existing, existingId: existing?.id ?? null };
  });

  // 처리 큐 상태
  app.get('/api/media/processing', { preHandler: authenticate }, async () => {
    return getQueueStatus();
  });

  // 업로드
  app.post('/api/media/upload', { preHandler: authenticate }, async (request, reply) => {
    // 업로드 복원(#3): 기본 활성. env UPLOAD_ENABLED='false'로만 비활성(kill-switch).
    if (process.env.UPLOAD_ENABLED === 'false') {
      return reply.code(403).send({ error: '이 앱에서는 업로드가 비활성화되어 있습니다' });
    }
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file' });

    const mimeType = data.mimetype;
    const type = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : null;
    if (!type) return reply.code(400).send({ error: 'Unsupported file type' });

    const ext = path.extname(data.filename);
    const filename = uuidv4() + ext;
    const filePath = path.join(DATA_DIR, 'originals', filename);

    app.log.info({ originalName: data.filename, mimeType, type }, 'Upload started');

    // 파일 저장 (pipeline으로 안전하게 스트림 처리)
    await pipeline(data.file, fs.createWriteStream(filePath));

    const stat = fs.statSync(filePath);
    app.log.info({ originalName: data.filename, size: stat.size, filename }, 'File saved');

    // 빠른 해시: 첫 4MB + 마지막 4MB + 파일 크기 (클라이언트와 동일 방식)
    const fileHash = await computeQuickHash(filePath, stat.size);
    app.log.info({ originalName: data.filename, hash: fileHash.slice(0, 12) }, 'Hash computed');

    const existing = db.prepare('SELECT id FROM media WHERE hash = ?').get(fileHash) as any;
    if (existing) {
      fs.unlinkSync(filePath);
      app.log.info({ originalName: data.filename, existingId: existing.id }, 'Duplicate skipped');
      return { ok: true, duplicate: true, existingId: existing.id };
    }

    const uploaderId = (request as any).user.userId;
    enqueue({ filename, originalName: data.filename, mimeType, type, size: stat.size, uploaderId, hash: fileHash });
    app.log.info({ originalName: data.filename, uploaderId, filename }, 'Enqueued for processing');

    return { ok: true, filename };
  });

  // 날짜 수정
  app.patch('/api/media/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId, role } = (request as any).user;
    const { createdAt } = request.body as { createdAt: string };

    const media = db.prepare('SELECT uploaderId FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });
    if (media.uploaderId !== userId && role !== 'master') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // YY-MM-DD HH:mm 또는 YYYY-MM-DD HH:mm:ss 형태 허용
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(createdAt)) {
      return reply.code(400).send({ error: 'Invalid date format' });
    }

    const fullDate = createdAt.length === 16 ? createdAt + ':00' : createdAt;
    db.prepare('UPDATE media SET createdAt = ? WHERE id = ?').run(fullDate, parseInt(id));
    return { ok: true, createdAt: fullDate };
  });

  // 삭제
  app.delete('/api/media/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId, role } = (request as any).user;

    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });

    if (media.uploaderId !== userId && role !== 'master') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // 외부 소스 파일은 삭제하지 않음 (원본은 다른 앱에 속함)
    if (!media.source || media.source === 'local') {
      const originalPath = path.join(DATA_DIR, 'originals', media.filename);
      const thumbPath = path.join(DATA_DIR, 'thumbnails', media.filename + '.webp');
      const hlsDir = path.join(DATA_DIR, 'hls', media.filename);
      if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });
    }

    db.prepare('DELETE FROM media WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // 원본 파일 서빙 (Range Request 지원)
  app.get('/api/media/:id/file', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const media = db.prepare('SELECT filename, mimeType, size, source FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });

    const filePath = path.join(resolveDataDir(media.source), 'originals', media.filename);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'File not found' });

    const range = request.headers.range;
    const stat = fs.statSync(filePath);

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0]);
      const end = parts[1] ? parseInt(parts[1]) : stat.size - 1;
      const chunkSize = end - start + 1;

      reply.code(206).headers({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': media.mimeType,
      });
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply.headers({
      'Content-Length': stat.size,
      'Content-Type': media.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'max-age=31536000, immutable',
    });
    return reply.send(fs.createReadStream(filePath));
  });

  // 썸네일 서빙
  app.get('/api/media/:id/thumb', async (request, reply) => {
    const { id } = request.params as { id: string };
    const media = db.prepare('SELECT filename, type, source FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });

    // ?w=640|1280 → 고해상도 파생본. 없으면 원본에서 만들어 캐시한다.
    // (실패하면 아래 300px 썸네일로 조용히 폴백)
    const width = parseDerivativeWidth((request.query as any)?.w);
    if (width) {
      const deriv = await ensureDerivative(resolveDataDir(media.source), media.filename, media.type, width);
      if (deriv) {
        reply.headers({
          'Content-Type': 'image/webp',
          'Cache-Control': 'max-age=31536000, immutable',
        });
        return reply.send(fs.createReadStream(deriv));
      }
    }

    const thumbPath = path.join(resolveDataDir(media.source), 'thumbnails', media.filename + '.webp');
    if (!fs.existsSync(thumbPath)) {
      // 썸네일이 애초에 안 만들어진 항목(전체의 0.02% 수준)은 갤러리에 빈 칸으로 남는다.
      // 원본에서 한 번 만들어 캐시하고 그걸 내려준다.
      const rescued = await ensureDerivative(resolveDataDir(media.source), media.filename, media.type, 640);
      if (!rescued) return reply.code(404).send({ error: 'Thumbnail not found' });
      reply.headers({
        'Content-Type': 'image/webp',
        'Cache-Control': 'max-age=31536000, immutable',
      });
      return reply.send(fs.createReadStream(rescued));
    }

    reply.headers({
      'Content-Type': 'image/webp',
      'Cache-Control': 'max-age=31536000, immutable',
    });
    return reply.send(fs.createReadStream(thumbPath));
  });

  // HLS playlist 서빙
  app.get('/api/media/:id/hls/playlist.m3u8', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const media = db.prepare('SELECT filename, source FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });

    const playlistPath = path.join(resolveDataDir(media.source), 'hls', media.filename, 'playlist.m3u8');
    if (!fs.existsSync(playlistPath)) return reply.code(404).send({ error: 'HLS not available' });

    reply.headers({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
    });
    return reply.send(fs.createReadStream(playlistPath));
  });

  // HLS segment 서빙
  app.get('/api/media/:id/hls/:segment', { preHandler: authenticate }, async (request, reply) => {
    const { id, segment } = request.params as { id: string; segment: string };
    if (segment.includes('/') || segment.includes('\\') || segment.includes('..')) {
      return reply.code(400).send({ error: 'Invalid segment' });
    }
    const media = db.prepare('SELECT filename, source FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });

    const segmentPath = path.join(resolveDataDir(media.source), 'hls', media.filename, segment);
    if (!fs.existsSync(segmentPath)) return reply.code(404).send({ error: 'Segment not found' });

    const contentType = segment.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
    reply.headers({
      'Content-Type': contentType,
      'Cache-Control': 'max-age=31536000, immutable',
    });
    return reply.send(fs.createReadStream(segmentPath));
  });

  // 다운로드 (원본 다운로드 + 기록)
  app.get('/api/media/:id/download', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = (request as any).user.userId;

    const media = db.prepare('SELECT filename, originalName, mimeType, size, source FROM media WHERE id = ?').get(parseInt(id)) as any;
    if (!media) return reply.code(404).send({ error: 'Not found' });

    const filePath = path.join(resolveDataDir(media.source), 'originals', media.filename);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'File not found' });

    // 다운로드 기록
    db.prepare('INSERT OR IGNORE INTO downloads (mediaId, userId) VALUES (?, ?)').run(parseInt(id), userId);

    // Content-Length는 DB 값이 아니라 실제 파일 크기를 사용한다.
    // (예전 업로드는 후처리로 파일 크기가 DB값과 달라져, DB값을 쓰면 다운로드가 잘렸음)
    const stat = fs.statSync(filePath);
    // 한글 파일명은 RFC 5987(filename*)로 보내고, 구형 클라이언트용 ASCII 폴백을 함께 준다.
    const safeName = media.originalName.replace(/[\r\n"]/g, '_');
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
    reply.headers({
      'Content-Type': media.mimeType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Content-Length': stat.size,
    });
    return reply.send(fs.createReadStream(filePath));
  });

  // ===== 갤러리 이벤트 자막 (날짜 범위 → 'N일차' 자동) =====
  // ===== 가족 앱 공유 범위 조회/변경 (master 전용) =====
  //
  // 여기(친척앱)에 있는 사진도 원본은 가족 앱 소유다. 관리자가 사진을 보다가
  // "이건 땅땅&콩콩에서 내리자" 또는 "이건 외부까지 열자" 싶을 때 가족 앱으로
  // 건너가지 않아도 되게, 해시로 원본을 찾아 플래그만 바꾼다.
  // 파일과 이 앱의 media 행은 건드리지 않는다.

  /** 이 앱의 media.id → 가족 앱 media 행 (해시 매칭). 없으면 null. */
  function findFamilyMedia(mediaId: number): any | null {
    if (!familyDb) return null;
    const row = db.prepare('SELECT hash FROM media WHERE id = ?').get(mediaId) as { hash: string | null } | undefined;
    if (!row?.hash) return null;
    try {
      return familyDb.prepare(
        "SELECT id, visibility, externalShared FROM media WHERE hash = ? ORDER BY CASE visibility WHEN 'shared' THEN 0 ELSE 1 END, id LIMIT 1"
      ).get(row.hash) || null;
    } catch (err) {
      console.error('[scope] 가족 앱 조회 실패:', err);
      return null;
    }
  }

  app.get('/api/media/:id/family-scope', { preHandler: authenticate }, async (request, reply) => {
    const { role } = (request as any).user;
    if (role !== 'master') return reply.code(403).send({ error: 'Forbidden' });
    const fam = findFamilyMedia(parseInt((request.params as { id: string }).id));
    if (!fam) return { linked: false, shared: false, externalShared: false };
    return { linked: true, familyMediaId: fam.id, shared: fam.visibility === 'shared', externalShared: !!fam.externalShared };
  });

  app.post('/api/media/:id/family-scope', { preHandler: authenticate }, async (request, reply) => {
    const { role } = (request as any).user;
    if (role !== 'master') return reply.code(403).send({ error: 'Forbidden' });
    if (!familyDb) return reply.code(400).send({ error: '가족 앱 연결 불가' });

    const fam = findFamilyMedia(parseInt((request.params as { id: string }).id));
    if (!fam) return reply.code(404).send({ error: '가족 앱에서 원본을 찾지 못했어요' });

    const { shared, externalShared } = request.body as { shared?: boolean; externalShared?: boolean };

    try {
      if (typeof shared === 'boolean') {
        if (shared) {
          familyDb.prepare("UPDATE media SET visibility = 'shared', ownerId = NULL WHERE id = ?").run(fam.id);
        } else {
          // 공유를 내리면 더 넓은 범위도 함께 내려간다(가족 앱 unshare와 같은 불변식).
          familyDb.prepare("UPDATE media SET visibility = 'private', ownerId = uploaderId, externalShared = 0, externalSharedAt = NULL WHERE id = ?").run(fam.id);
          familyDb.prepare('DELETE FROM album_items WHERE mediaId = ?').run(fam.id);
        }
      }
      if (typeof externalShared === 'boolean') {
        if (externalShared) {
          // 공유 상태일 때만 외부 공개 가능 — 가족 앱과 같은 규칙
          familyDb.prepare(
            "UPDATE media SET externalShared = 1, externalSharedAt = datetime('now', '+9 hours') WHERE id = ? AND visibility = 'shared'"
          ).run(fam.id);
        } else {
          familyDb.prepare('UPDATE media SET externalShared = 0, externalSharedAt = NULL WHERE id = ?').run(fam.id);
        }
      }
      const after = familyDb.prepare('SELECT visibility, externalShared FROM media WHERE id = ?').get(fam.id) as any;
      return { ok: true, shared: after.visibility === 'shared', externalShared: !!after.externalShared };
    } catch (err) {
      request.log.error(err, 'family-scope 변경 실패');
      return reply.code(500).send({ error: '변경하지 못했어요' });
    }
  });

  app.get('/api/gallery-events', { preHandler: authenticate }, async () => {
    return db.prepare('SELECT id, startDate, endDate, title, color FROM gallery_events ORDER BY startDate DESC').all();
  });

  app.post('/api/gallery-events', { preHandler: authenticate }, async (request, reply) => {
    const { userId, role } = (request as any).user;
    if (role !== 'master') return reply.code(403).send({ error: '관리자만 가능합니다' });
    let { startDate, endDate, title, color } = request.body as { startDate: string; endDate: string; title: string; color?: string };
    if (!title?.trim()) return reply.code(400).send({ error: '제목을 입력하세요' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return reply.code(400).send({ error: '날짜 형식 오류' });
    }
    if (endDate < startDate) [startDate, endDate] = [endDate, startDate];
    const r = db.prepare('INSERT INTO gallery_events (startDate, endDate, title, color, createdBy) VALUES (?, ?, ?, ?, ?)')
      .run(startDate, endDate, title.trim(), color || '#946b2d', userId);
    return db.prepare('SELECT id, startDate, endDate, title, color FROM gallery_events WHERE id = ?').get(r.lastInsertRowid);
  });

  app.patch('/api/gallery-events/:id', { preHandler: authenticate }, async (request, reply) => {
    if ((request as any).user.role !== 'master') return reply.code(403).send({ error: '관리자만 가능합니다' });
    const { id } = request.params as { id: string };
    let { startDate, endDate, title, color } = request.body as { startDate: string; endDate: string; title: string; color?: string };
    if (!title?.trim()) return reply.code(400).send({ error: '제목을 입력하세요' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return reply.code(400).send({ error: '날짜 형식 오류' });
    }
    if (endDate < startDate) [startDate, endDate] = [endDate, startDate];
    const ev = db.prepare('SELECT id FROM gallery_events WHERE id = ?').get(parseInt(id));
    if (!ev) return reply.code(404).send({ error: 'Not found' });
    db.prepare('UPDATE gallery_events SET startDate = ?, endDate = ?, title = ?, color = ? WHERE id = ?')
      .run(startDate, endDate, title.trim(), color || '#946b2d', parseInt(id));
    return db.prepare('SELECT id, startDate, endDate, title, color FROM gallery_events WHERE id = ?').get(parseInt(id));
  });

  app.delete('/api/gallery-events/:id', { preHandler: authenticate }, async (request, reply) => {
    if ((request as any).user.role !== 'master') return reply.code(403).send({ error: '관리자만 가능합니다' });
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM gallery_events WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // 구 앱 → 신규 앱(family) 단방향 적용 (복사本, 신규 앱은 이후 독립 수정 가능)
  app.post('/api/gallery-events/:id/apply-to-family', { preHandler: authenticate }, async (request, reply) => {
    if ((request as any).user.role !== 'master') return reply.code(403).send({ error: '관리자만 가능합니다' });
    if (!familyDb) return reply.code(400).send({ error: '신규 앱 연결 불가' });
    const { id } = request.params as { id: string };
    const ev = db.prepare('SELECT startDate, endDate, title, color FROM gallery_events WHERE id = ?').get(parseInt(id)) as any;
    if (!ev) return reply.code(404).send({ error: 'Not found' });
    // 신규 앱 DB에 테이블 보장 (배포 순서 무관하게)
    familyDb.exec(`CREATE TABLE IF NOT EXISTS gallery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, startDate TEXT NOT NULL, endDate TEXT NOT NULL,
      title TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#E8943A', createdBy INTEGER,
      createdAt TEXT DEFAULT (datetime('now', '+9 hours'))
    )`);
    // 같은 기간+제목이 이미 있으면 갱신, 없으면 삽입 (중복 방지)
    const existing = familyDb.prepare('SELECT id FROM gallery_events WHERE startDate = ? AND endDate = ? AND title = ?')
      .get(ev.startDate, ev.endDate, ev.title) as any;
    if (existing) {
      familyDb.prepare('UPDATE gallery_events SET color = ? WHERE id = ?').run(ev.color, existing.id);
    } else {
      familyDb.prepare('INSERT INTO gallery_events (startDate, endDate, title, color, createdBy) VALUES (?, ?, ?, ?, NULL)')
        .run(ev.startDate, ev.endDate, ev.title, ev.color);
    }
    return { ok: true };
  });
}

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

async function computeQuickHash(filePath: string, fileSize: number): Promise<string> {
  const hash = crypto.createHash('sha256');

  if (fileSize <= CHUNK_SIZE) {
    // 작은 파일: 전체 해시
    const data = fs.readFileSync(filePath);
    hash.update(data);
  } else {
    // 큰 파일: head 4MB + tail 4MB + 파일 크기
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(CHUNK_SIZE);
    const tail = Buffer.alloc(CHUNK_SIZE);
    fs.readSync(fd, head, 0, CHUNK_SIZE, 0);
    fs.readSync(fd, tail, 0, CHUNK_SIZE, fileSize - CHUNK_SIZE);
    fs.closeSync(fd);
    hash.update(head);
    hash.update(tail);
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeDoubleBE(fileSize);
    hash.update(sizeBuf);
  }

  return hash.digest('hex');
}
