const BASE = '/api';
const IS_PWA = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches;

async function request<T>(url: string, options?: RequestInit & { skipAuthRedirect?: boolean }): Promise<T> {
  const { skipAuthRedirect, ...fetchOptions } = options || {};
  const res = await fetch(BASE + url, {
    credentials: 'include',
    ...fetchOptions,
    headers: {
      'X-App-Mode': IS_PWA ? 'pwa' : 'browser',
      ...(!fetchOptions?.body || fetchOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...fetchOptions?.headers,
    },
  });
  if (res.status === 401) {
    if (!skipAuthRedirect && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || res.statusText);
  }
  return res.json();
}

export interface User {
  id: number;
  name: string;
  profileImage: string | null;
  role: string;
  createdAt: string;
}

export interface MediaItem {
  id: number;
  uploaderId: number;
  filename: string;
  originalName: string;
  mimeType: string;
  type: 'image' | 'video';
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  createdAt: string;
  uploadedAt: string | null;
  uploaderName: string;
  uploaderImage: string | null;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  shareCount: number;
  liked: boolean;
  favorited: boolean;
  viewers: { userId: number; name: string; profileImage: string | null }[];
  downloaders: { userId: number; name: string; profileImage: string | null }[];
}

export interface GalleryEvent {
  id: number;
  startDate: string;
  endDate: string;
  title: string;
  color: string;
}
export type GalleryEventInput = { startDate: string; endDate: string; title: string; color: string };

export interface Comment {
  id: number;
  content: string;
  createdAt: string;
  userId: number;
  name: string;
  profileImage: string | null;
  parentId: number | null;
  editedAt: string | null;
}

export const api = {
  getMe: () => request<User>('/auth/me', { skipAuthRedirect: true }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  getMedia: (cursor?: string | null, sort?: string) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (sort) params.set('sort', sort);
    const qs = params.toString();
    return request<{ items: MediaItem[]; nextCursor: string | null }>(
      `/media${qs ? `?${qs}` : ''}`,
    );
  },

  getMediaDetail: (id: number) => request<MediaItem>(`/media/${id}`),
  getMediaIds: () => request<{ items: { id: number; filename: string; type: string; createdAt: string }[] }>('/media/ids'),

  uploadFile: (file: File, onProgress?: (pct: number) => void) => {
    return new Promise<{ ok: boolean; filename?: string; duplicate?: boolean }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/media/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-App-Mode', IS_PWA ? 'pwa' : 'browser');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error('Upload failed'));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));

      const formData = new FormData();
      formData.append('file', file);
      xhr.send(formData);
    });
  },

  checkDuplicate: (hash: string) =>
    request<{ duplicate: boolean; existingId: number | null }>('/media/check-duplicate', {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),

  hashFile: async (file: File): Promise<string> => {
    // 청크 단위로 해시 계산 (대용량 파일 메모리 절약)
    const CHUNK = 4 * 1024 * 1024; // 4MB
    if (file.size <= CHUNK) {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // 큰 파일: 첫 4MB + 마지막 4MB + 파일 크기로 빠른 해시
    const head = await file.slice(0, CHUNK).arrayBuffer();
    const tail = await file.slice(-CHUNK).arrayBuffer();
    const sizeBuf = new ArrayBuffer(8);
    new DataView(sizeBuf).setFloat64(0, file.size);
    const combined = new Uint8Array(head.byteLength + tail.byteLength + 8);
    combined.set(new Uint8Array(head), 0);
    combined.set(new Uint8Array(tail), head.byteLength);
    combined.set(new Uint8Array(sizeBuf), head.byteLength + tail.byteLength);
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  getProcessingStatus: () => request<{
    current: { filename: string; originalName: string; startedAt: number } | null;
    queue: { filename: string; originalName: string }[];
    recentResults: { filename: string; originalName: string; status: 'done' | 'error'; error?: string; elapsed: number }[];
  }>('/media/processing'),

  updateMediaDate: (id: number, createdAt: string) =>
    request<{ ok: boolean; createdAt: string }>(`/media/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ createdAt }),
    }),

  deleteMedia: (id: number) => request<{ ok: boolean }>(`/media/${id}`, { method: 'DELETE' }),

  // 갤러리 이벤트 자막
  getGalleryEvents: () => request<GalleryEvent[]>('/gallery-events'),
  createGalleryEvent: (e: GalleryEventInput) => request<GalleryEvent>('/gallery-events', { method: 'POST', body: JSON.stringify(e) }),
  updateGalleryEvent: (id: number, e: GalleryEventInput) => request<GalleryEvent>(`/gallery-events/${id}`, { method: 'PATCH', body: JSON.stringify(e) }),
  deleteGalleryEvent: (id: number) => request<{ ok: boolean }>(`/gallery-events/${id}`, { method: 'DELETE' }),
  applyEventToFamily: (id: number) => request<{ ok: boolean }>(`/gallery-events/${id}/apply-to-family`, { method: 'POST' }),

  recordView: (id: number) => request<{ ok: boolean }>(`/media/${id}/view`, { method: 'POST' }),

  toggleLike: (id: number) => request<{ liked: boolean }>(`/media/${id}/like`, { method: 'POST' }),
  toggleFavorite: (id: number) => request<{ favorited: boolean }>(`/media/${id}/favorite`, { method: 'POST' }),
  recordShare: (id: number) => request<{ ok: boolean }>(`/media/${id}/share`, { method: 'POST' }),

  getComments: (id: number) => request<Comment[]>(`/media/${id}/comments`),

  addComment: (id: number, content: string, parentId?: number) =>
    request<Comment>(`/media/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parentId }),
    }),

  editComment: (id: number, content: string) =>
    request<Comment>(`/comments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),

  deleteComment: (id: number) =>
    request<{ ok: boolean }>(`/comments/${id}`, { method: 'DELETE' }),

  getUsers: () => request<User[]>('/users'),
  banUser: (id: number, banned: boolean) =>
    request<{ ok: boolean }>(`/users/${id}/ban`, { method: 'POST', body: JSON.stringify({ banned }) }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),

  thumbUrl: (id: number, v?: string) => `${BASE}/media/${id}/thumb${v ? `?v=${v}` : ''}`,
  fileUrl: (id: number, v?: string) => `${BASE}/media/${id}/file${v ? `?v=${v}` : ''}`,
  hlsUrl: (id: number) => `${BASE}/media/${id}/hls/playlist.m3u8`,
  downloadUrl: (id: number) => `${BASE}/media/${id}/download`,
};
