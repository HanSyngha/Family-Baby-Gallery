import { useState, useRef, useCallback } from 'react';
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
  sizes?: string;          // srcset용 — 그리드가 실제 열 수를 알려준다
}

function formatDuration(sec: number | null): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function MediaCard({ item, index = 0, onClick, selectMode, selected, onLongPress, sizes }: Props) {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // 썸네일 src를 바로 세팅하고 브라우저 네이티브 loading="lazy"에 지연로딩을 맡긴다.
  // (예전 IntersectionObserver 방식은 초기 마운트에서 안 깨어나 '첫 스크롤 전까지 안 뜨는' 문제 발생)
  // 300px 단일 썸네일은 DPR 2~3 폰에서 2배 업스케일이라 뿌옇다.
  // 640/1280 파생본을 srcset으로 같이 주고 브라우저가 화면 밀도에 맞게 고르게 한다.
  const src = api.thumbUrl(item.id, item.filename);
  const srcSet = [
    `${src} 300w`,
    `${api.thumbUrl(item.id, item.filename, 640)} 640w`,
    `${api.thumbUrl(item.id, item.filename, 1280)} 1280w`,
  ].join(', ');
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

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

  return (
    <div
      className={`${styles.card} ${selectMode && selected ? styles.selected : ''}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className={styles.imageWrap}>
        <img
          ref={imgRef}
          src={src || undefined}
          srcSet={srcSet}
          sizes={sizes ?? '(min-width:1400px) 20vw, (min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw'}
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

      {!selectMode && (item.likeCount > 0 || item.commentCount > 0) && (
        <div className={styles.countOverlay}>
          {item.likeCount > 0 && (
            <span className={item.liked ? styles.countLiked : undefined}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" /></svg>
              {item.likeCount}
            </span>
          )}
          {item.commentCount > 0 && (
            <span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              {item.commentCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
