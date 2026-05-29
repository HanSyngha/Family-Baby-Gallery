import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { api, type MediaItem, type GalleryEvent } from '../api';
import MediaCard from './MediaCard';
import EventModal from './EventModal';
import styles from './MediaGrid.module.css';

interface Props {
  items: MediaItem[];
  onItemClick: (index: number) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  sort?: string;
  columns?: number;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onLongPress?: (firstId: number) => void;
  onLikeToggle?: (id: number, liked: boolean) => void;
  isAdmin?: boolean;
}

function formatDateHeader(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${y.slice(2)}.${m}.${d}`;
}

function getDateKey(dateStr: string): string {
  return dateStr.slice(0, 10);
}

// 설이 생일(2026-02-19)을 1일차로 계산. 생일 이전이면 null.
const SEOL_BIRTH = new Date('2026-02-19T00:00:00');
function seolDay(dateKey: string): number | null {
  const d = new Date(dateKey + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const day = Math.floor((d.getTime() - SEOL_BIRTH.getTime()) / 86400000) + 1;
  return day >= 1 ? day : null;
}

interface DateGroup {
  dateKey: string;
  label: string;
  items: { item: MediaItem; globalIndex: number }[];
}

export default function MediaGrid({ items, onItemClick, onLoadMore, hasMore, sort, columns, selectMode, selectedIds, onLongPress, onLikeToggle, isAdmin }: Props) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 갤러리 이벤트 자막
  const [events, setEvents] = useState<GalleryEvent[]>([]);
  const [editDate, setEditDate] = useState<string | null>(null);
  const refetchEvents = useCallback(() => { api.getGalleryEvents().then(setEvents).catch(() => {}); }, []);
  useEffect(() => { refetchEvents(); }, [refetchEvents]);

  const eventForDate = useCallback(
    (dateKey: string) => events.find(e => dateKey >= e.startDate && dateKey <= e.endDate) ?? null,
    [events]
  );
  const captionFor = (dateKey: string): { text: string; color: string } | null => {
    const e = eventForDate(dateKey);
    if (!e) return null;
    if (e.startDate === e.endDate) return { text: e.title, color: e.color };
    const day = Math.floor((new Date(dateKey + 'T00:00:00').getTime() - new Date(e.startDate + 'T00:00:00').getTime()) / 86400000) + 1;
    return { text: `${e.title} ${day}일차`, color: e.color };
  };

  const pressTimer = useRef<number | null>(null);
  const cancelPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  const startPress = (dateKey: string) => { cancelPress(); pressTimer.current = window.setTimeout(() => setEditDate(dateKey), 450); };

  const groups = useMemo(() => {
    const map = new Map<string, DateGroup>();
    items.forEach((item, idx) => {
      const key = getDateKey(item.createdAt);
      if (!map.has(key)) {
        map.set(key, { dateKey: key, label: formatDateHeader(item.createdAt), items: [] });
      }
      map.get(key)!.items.push({ item, globalIndex: idx });
    });
    return Array.from(map.values());
  }, [items]);

  // 월별 점프용: 같은 월의 첫 그룹에만 month id 부여
  const monthFirstKeys = useMemo(() => {
    const seen = new Set<string>();
    const result = new Map<string, string>();
    for (const g of groups) {
      const month = g.dateKey.slice(0, 7);
      if (!seen.has(month)) {
        seen.add(month);
        result.set(g.dateKey, month);
      }
    }
    return result;
  }, [groups]);

  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) loadMoreRef.current();
    }, { rootMargin: '400px' });
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [hasMore, items.length]);

  const gridStyle = columns ? { '--grid-cols': columns } as React.CSSProperties : undefined;

  const renderCard = (item: MediaItem, globalIndex: number, animIndex: number) => (
    <MediaCard
      key={item.id}
      item={item}
      index={animIndex}
      onClick={() => onItemClick(globalIndex)}
      selectMode={selectMode}
      selected={selectedIds?.has(item.id)}
      onLongPress={onLongPress ? () => onLongPress(item.id) : undefined}
      onLikeToggle={onLikeToggle}
    />
  );

  // 좋아요순/조회순/즐겨찾기: 날짜 그룹 없이 flat 그리드
  if (sort && sort !== 'recent') {
    return (
      <div className={styles.container}>
        <div className={styles.grid} style={gridStyle}>
          {items.map((item, idx) => renderCard(item, idx, idx))}
        </div>
      </div>
    );
  }

  // 최신순: 날짜별 그룹
  return (
    <div className={styles.container}>
      {groups.map((group) => {
        const monthId = monthFirstKeys.get(group.dateKey);
        return (
          <section key={group.dateKey} className={styles.section} id={monthId ? `month-${monthId}` : undefined}>
            <div
              className={styles.dateHeader}
              onPointerDown={isAdmin ? () => startPress(group.dateKey) : undefined}
              onPointerUp={isAdmin ? cancelPress : undefined}
              onPointerLeave={isAdmin ? cancelPress : undefined}
              onPointerCancel={isAdmin ? cancelPress : undefined}
            >
              <span className={styles.dateLine} />
              <span className={styles.dateLabel}>{group.label}</span>
              {seolDay(group.dateKey) !== null && (
                <span className={styles.dayBadge}>설이 {seolDay(group.dateKey)}일</span>
              )}
              <span className={styles.dateCount}>{group.items.length}장</span>
              <span className={styles.dateLine} />
            </div>
            {(() => {
              const cap = captionFor(group.dateKey);
              return cap ? (
                <div className={styles.eventCaption} style={{ color: cap.color, cursor: isAdmin ? 'pointer' : 'default' }} onClick={isAdmin ? () => setEditDate(group.dateKey) : undefined}>
                  {cap.text}
                </div>
              ) : null;
            })()}
            <div className={styles.grid} style={gridStyle}>
              {group.items.map(({ item, globalIndex }, i) => renderCard(item, globalIndex, i))}
            </div>
          </section>
        );
      })}
      {hasMore && <div ref={sentinelRef} className={styles.sentinel} />}
      {isAdmin && editDate && (
        <EventModal
          date={editDate}
          event={eventForDate(editDate)}
          onSaved={() => { refetchEvents(); setEditDate(null); }}
          onClose={() => setEditDate(null)}
          onApply={async (id) => { await api.applyEventToFamily(id); }}
        />
      )}
    </div>
  );
}
