import { useState, useRef, useEffect, useCallback } from 'react';
import type { MediaItem } from '../api';
import { api } from '../api';
import styles from './MediaCard.module.css';

interface Props {
  item: MediaItem;
  index?: number;
  onClick: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onLongPress?: () => void;
  onLikeToggle?: (id: number, liked: boolean) => void;
}

function formatDuration(sec: number | null): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}.${mm}.${dd} ${hh}:${mi}`;
}

export default function MediaCard({ item, index = 0, onClick, selectMode, selected, onLongPress, onLikeToggle }: Props) {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSrc(api.thumbUrl(item.id, item.filename));
          observerRef.current?.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observerRef.current.observe(el);

    return () => observerRef.current?.disconnect();
  }, [item.id]);

  const handlePointerDown = useCallback(() => {
    if (!onLongPress || selectMode) return;
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      onLongPress();
    }, 500);
  }, [onLongPress, selectMode]);

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleClick = useCallback(() => {
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    onClick();
  }, [onClick]);

  const handleLike = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onLikeToggle) return;
    const result = await api.toggleLike(item.id);
    onLikeToggle(item.id, result.liked);
  }, [item.id, onLikeToggle]);

  return (
    <div
      className={`${styles.card} ${selectMode && selected ? styles.selected : ''}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className={styles.imageWrap}>
        <img
          ref={imgRef}
          src={src || undefined}
          alt={item.originalName}
          loading="lazy"
          decoding="async"
          className={`${styles.image} ${loaded ? styles.loaded : ''}`}
          onLoad={() => setLoaded(true)}
        />
        {!loaded && <div className={styles.placeholder} />}

        {/* 선택 모드 체크박스 */}
        {selectMode && (
          <div className={`${styles.checkbox} ${selected ? styles.checked : ''}`}>
            {selected && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
          </div>
        )}

        {!selectMode && item.uploadedAt && Date.now() - new Date(item.uploadedAt.replace(' ', 'T')).getTime() < 12 * 3600000 && (
          <span className={styles.newBadge}>NEW!</span>
        )}

        {/* 즐겨찾기 아이콘 */}
        {!selectMode && item.favorited && (
          <div className={styles.favBadge}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff" stroke="none">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </div>
        )}

        {item.type === 'video' && (
          <>
            <div className={styles.playIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            {item.duration && (
              <span className={styles.duration}>{formatDuration(item.duration)}</span>
            )}
          </>
        )}
      </div>

      <div className={styles.info}>
        <div className={styles.dateTime}>{formatDateTime(item.createdAt)}</div>
        <div className={styles.stats}>
          <button className={`${styles.likeCount} ${item.liked ? styles.active : ''}`} onClick={handleLike}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill={item.liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            {item.likeCount > 0 && <span>{item.likeCount}</span>}
          </button>
          {item.commentCount > 0 && (
            <div className={styles.commentCount}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>{item.commentCount}</span>
            </div>
          )}
          {item.viewCount > 0 && (
            <div className={styles.viewCount}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>{item.viewCount}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
