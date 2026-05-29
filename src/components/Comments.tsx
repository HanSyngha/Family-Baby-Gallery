import { useState, useEffect, useCallback } from 'react';
import { api, type Comment as CommentType, type User } from '../api';
import styles from './Comments.module.css';

interface Props {
  mediaId: number;
  user: User;
}

export default function Comments({ mediaId, user }: Props) {
  const [comments, setComments] = useState<CommentType[]>([]);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    api.getComments(mediaId).then(setComments).catch(() => {});
    setReplyTo(null);
    setEditId(null);
  }, [mediaId]);

  const submit = useCallback(async () => {
    if (!text.trim()) return;
    const c = await api.addComment(mediaId, text.trim());
    setComments(prev => [...prev, c]);
    setText('');
  }, [mediaId, text]);

  const submitReply = useCallback(async (topId: number) => {
    if (!replyText.trim()) return;
    const c = await api.addComment(mediaId, replyText.trim(), topId);
    setComments(prev => [...prev, c]);
    setReplyText('');
    setReplyTo(null);
  }, [mediaId, replyText]);

  const saveEdit = useCallback(async (id: number) => {
    if (!editText.trim()) return;
    const updated = await api.editComment(id, editText.trim());
    setComments(prev => prev.map(c => (c.id === id ? updated : c)));
    setEditId(null);
    setEditText('');
  }, [editText]);

  const remove = useCallback(async (id: number) => {
    if (!confirm('댓글을 삭제할까요?')) return;
    await api.deleteComment(id);
    setComments(prev => prev.filter(c => c.id !== id && c.parentId !== id));
  }, []);

  const tops = comments.filter(c => !c.parentId);
  const repliesOf = (id: number) => comments.filter(c => c.parentId === id);
  const fmt = (s: string) => s.slice(2, 10).replace(/-/g, '.');

  const renderComment = (c: CommentType, topId: number, isReply: boolean) => {
    const canEdit = c.userId === user.id || user.role === 'master';
    const editing = editId === c.id;
    return (
      <div key={c.id} className={isReply ? styles.reply : styles.commentBody}>
        <div className={styles.commentHeader}>
          <span className={styles.commentName}>{c.name}</span>
          <span className={styles.commentTime}>
            {fmt(c.createdAt)}{c.editedAt ? ' · 수정됨' : ''}
          </span>
        </div>
        {editing ? (
          <div className={styles.editRow}>
            <input
              className={styles.input}
              value={editText}
              autoFocus
              onChange={e => setEditText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(c.id); } }}
            />
            <button className={styles.sendBtn} onClick={() => saveEdit(c.id)} disabled={!editText.trim()}>저장</button>
            <button className={styles.ghostBtn} onClick={() => { setEditId(null); setEditText(''); }}>취소</button>
          </div>
        ) : (
          <>
            <div className={styles.commentText}>{c.content}</div>
            <div className={styles.actionsRow}>
              <button
                className={styles.actionLink}
                onClick={() => { setReplyTo(replyTo === topId ? null : topId); setReplyText(''); }}
              >답글</button>
              {canEdit && (
                <button className={styles.actionLink} onClick={() => { setEditId(c.id); setEditText(c.content); }}>수정</button>
              )}
              {canEdit && (
                <button className={`${styles.actionLink} ${styles.danger}`} onClick={() => remove(c.id)}>삭제</button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className={styles.comments}>
      <div className={styles.label}>댓글 ({comments.length})</div>
      <div className={styles.list}>
        {tops.length === 0 && <div className={styles.empty}>첫 댓글을 남겨보세요</div>}
        {tops.map(top => {
          const replies = repliesOf(top.id);
          return (
            <div key={top.id} className={styles.thread}>
              {renderComment(top, top.id, false)}
              {replies.length > 0 && (
                <div className={styles.replies}>
                  {replies.map(r => renderComment(r, top.id, true))}
                </div>
              )}
              {replyTo === top.id && (
                <div className={styles.replyInputWrap}>
                  <input
                    className={styles.input}
                    value={replyText}
                    autoFocus
                    placeholder={`${top.name}님에게 답글...`}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply(top.id); } }}
                  />
                  <button className={styles.sendBtn} onClick={() => submitReply(top.id)} disabled={!replyText.trim()}>답글</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.inputWrap}>
        <input
          className={styles.input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="댓글 입력..."
        />
        <button className={styles.sendBtn} onClick={submit} disabled={!text.trim()}>전송</button>
      </div>
    </div>
  );
}
