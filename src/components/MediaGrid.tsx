import { useMemo, useRef, useEffect } from 'react';
import type { MediaItem } from '../api';
import MediaCard from './MediaCard';
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
}

function formatDateHeader(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${y.slice(2)}.${m}.${d}`;
}

function getDateKey(dateStr: string): string {
  return dateStr.slice(0, 10);
}

interface DateGroup {
  dateKey: string;
  label: string;
  items: { item: MediaItem; globalIndex: number }[];
}

export default function MediaGrid({ items, onItemClick, onLoadMore, hasMore, sort, columns, selectMode, selectedIds, onLongPress, onLikeToggle }: Props) {
  const sentinelRef = useRef<HTMLDivElement>(null);

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
            <div className={styles.dateHeader}>
              <span className={styles.dateLine} />
              <span className={styles.dateLabel}>{group.label}</span>
              <span className={styles.dateCount}>{group.items.length}장</span>
              <span className={styles.dateLine} />
            </div>
            <div className={styles.grid} style={gridStyle}>
              {group.items.map(({ item, globalIndex }, i) => renderCard(item, globalIndex, i))}
            </div>
          </section>
        );
      })}
      {hasMore && <div ref={sentinelRef} className={styles.sentinel} />}
    </div>
  );
}
