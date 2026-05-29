import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import db from '../db.js';

export function registerInteractionRoutes(app: FastifyInstance) {
  // 확인(view) 기록
  app.post('/api/media/:id/view', { preHandler: authenticate }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request as any).user.userId;
    db.prepare('INSERT INTO views (mediaId, userId) VALUES (?, ?)').run(parseInt(id), userId);
    return { ok: true };
  });

  // 좋아요 토글
  app.post('/api/media/:id/like', { preHandler: authenticate }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request as any).user.userId;
    const mediaId = parseInt(id);

    const existing = db.prepare('SELECT id FROM likes WHERE mediaId = ? AND userId = ?').get(mediaId, userId);
    if (existing) {
      db.prepare('DELETE FROM likes WHERE mediaId = ? AND userId = ?').run(mediaId, userId);
      return { liked: false };
    }
    db.prepare('INSERT INTO likes (mediaId, userId) VALUES (?, ?)').run(mediaId, userId);
    return { liked: true };
  });

  // 즐겨찾기 토글
  app.post('/api/media/:id/favorite', { preHandler: authenticate }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request as any).user.userId;
    const mediaId = parseInt(id);

    const existing = db.prepare('SELECT id FROM favorites WHERE mediaId = ? AND userId = ?').get(mediaId, userId);
    if (existing) {
      db.prepare('DELETE FROM favorites WHERE mediaId = ? AND userId = ?').run(mediaId, userId);
      return { favorited: false };
    }
    db.prepare('INSERT INTO favorites (mediaId, userId) VALUES (?, ?)').run(mediaId, userId);
    return { favorited: true };
  });

  // 공유 기록
  app.post('/api/media/:id/share', { preHandler: authenticate }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request as any).user.userId;
    db.prepare('INSERT INTO shares (mediaId, userId) VALUES (?, ?)').run(parseInt(id), userId);
    return { ok: true };
  });

  // 댓글 목록 (대댓글 포함, parentId/editedAt 반환)
  app.get('/api/media/:id/comments', { preHandler: authenticate }, async (request) => {
    const { id } = request.params as { id: string };
    const rows = db.prepare(`
      SELECT c.id, c.content, c.createdAt, c.parentId, c.editedAt,
        u.id as userId, u.name, u.profileImage
      FROM comments c
      JOIN users u ON u.id = c.userId
      WHERE c.mediaId = ?
      ORDER BY c.createdAt ASC
    `).all(parseInt(id));
    return rows;
  });

  // 댓글 작성 (parentId 있으면 대댓글)
  app.post('/api/media/:id/comments', { preHandler: authenticate }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request as any).user.userId;
    const { content, parentId } = request.body as { content: string; parentId?: number };

    if (!content?.trim()) return { error: 'Empty content' };

    // parentId가 있으면 같은 미디어의 유효한 댓글인지 확인 (깊이는 1단계로 고정)
    let parent: number | null = null;
    if (parentId) {
      const p = db.prepare('SELECT id, mediaId, parentId FROM comments WHERE id = ?').get(parentId) as any;
      if (p && p.mediaId === parseInt(id)) {
        parent = p.parentId ?? p.id;
      }
    }

    const result = db.prepare('INSERT INTO comments (mediaId, userId, content, parentId) VALUES (?, ?, ?, ?)')
      .run(parseInt(id), userId, content.trim(), parent);

    const comment = db.prepare(`
      SELECT c.id, c.content, c.createdAt, c.parentId, c.editedAt,
        u.id as userId, u.name, u.profileImage
      FROM comments c
      JOIN users u ON u.id = c.userId
      WHERE c.id = ?
    `).get(result.lastInsertRowid);

    return comment;
  });

  // 댓글 수정 (작성자/마스터만)
  app.patch('/api/comments/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId, role } = (request as any).user;
    const { content } = request.body as { content: string };

    if (!content?.trim()) return reply.code(400).send({ error: 'Empty content' });

    const comment = db.prepare('SELECT userId FROM comments WHERE id = ?').get(parseInt(id)) as any;
    if (!comment) return reply.code(404).send({ error: 'Not found' });
    if (comment.userId !== userId && role !== 'master') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const editedAt = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE comments SET content = ?, editedAt = ? WHERE id = ?').run(content.trim(), editedAt, parseInt(id));

    const updated = db.prepare(`
      SELECT c.id, c.content, c.createdAt, c.parentId, c.editedAt,
        u.id as userId, u.name, u.profileImage
      FROM comments c
      JOIN users u ON u.id = c.userId
      WHERE c.id = ?
    `).get(parseInt(id));
    return updated;
  });

  // 댓글 삭제 (대댓글도 함께 삭제)
  app.delete('/api/comments/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId, role } = (request as any).user;

    const comment = db.prepare('SELECT userId FROM comments WHERE id = ?').get(parseInt(id)) as any;
    if (!comment) return reply.code(404).send({ error: 'Not found' });
    if (comment.userId !== userId && role !== 'master') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    db.prepare('DELETE FROM comments WHERE id = ? OR parentId = ?').run(parseInt(id), parseInt(id));
    return { ok: true };
  });
}
