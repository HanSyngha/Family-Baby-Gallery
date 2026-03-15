import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../api';

export interface UploadFile {
  file: File;
  progress: number;
  status: 'pending' | 'hashing' | 'uploading' | 'done' | 'duplicate' | 'error';
  retryCount: number;
}

export function useUploadQueue(onUploaded: () => void) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const uploadingRef = useRef(false);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const mediaExts = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|mp4|mov|avi|mkv|webm|3gp|m4v)$/i;
    const items = Array.from(newFiles)
      .filter(f => f.type.startsWith('image/') || f.type.startsWith('video/') || mediaExts.test(f.name))
      .map(file => ({ file, progress: 0, status: 'pending' as const, retryCount: 0 }));
    if (items.length === 0) return;
    setFiles(prev => [...prev, ...items]);
  }, []);

  // 순차 처리: 해시 계산 → 중복 체크 → 업로드
  useEffect(() => {
    if (uploadingRef.current) return;
    const pendingIdx = files.findIndex(f => f.status === 'pending');
    if (pendingIdx === -1) return;

    uploadingRef.current = true;
    const fileToUpload = files[pendingIdx].file;

    // 1. 해시 계산 중 표시
    setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'hashing' } : f));

    api.hashFile(fileToUpload)
      .then(async (hash) => {
        // 2. 서버에 중복 확인
        const check = await api.checkDuplicate(hash);
        if (check.duplicate) {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'duplicate', progress: 100 } : f));
          return;
        }

        // 3. 중복 아니면 업로드
        setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'uploading' } : f));

        const res = await api.uploadFile(fileToUpload, (pct) => {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, progress: pct } : f));
        });

        if (res.duplicate) {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'duplicate', progress: 100 } : f));
        } else {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'done', progress: 100 } : f));
          onUploaded();
        }
      })
      .catch(() => {
        setFiles(prev => prev.map((f, i) => {
          if (i !== pendingIdx) return f;
          // 자동 재시도 2회
          if (f.retryCount < 2) {
            return { ...f, status: 'pending', progress: 0, retryCount: f.retryCount + 1 };
          }
          return { ...f, status: 'error' };
        }));
      })
      .finally(() => {
        uploadingRef.current = false;
        setFiles(prev => [...prev]);
      });
  }, [files.length, files.filter(f => f.status === 'done' || f.status === 'error' || f.status === 'duplicate').length]);

  // beforeunload
  useEffect(() => {
    const hasActive = files.some(f => f.status === 'uploading' || f.status === 'pending' || f.status === 'hashing');
    if (!hasActive) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [files]);

  const retryFile = useCallback((index: number) => {
    setFiles(prev => prev.map((f, i) =>
      i === index && f.status === 'error'
        ? { ...f, status: 'pending' as const, progress: 0, retryCount: 0 }
        : f
    ));
  }, []);

  const clearDone = useCallback(() => {
    setFiles(prev => prev.filter(f => f.status !== 'done' && f.status !== 'error' && f.status !== 'duplicate'));
  }, []);

  const doneCount = files.filter(f => f.status === 'done').length;
  const dupCount = files.filter(f => f.status === 'duplicate').length;
  const totalCount = files.length;
  const activeCount = files.filter(f => f.status === 'uploading' || f.status === 'pending' || f.status === 'hashing').length;
  const currentFile = files.find(f => f.status === 'uploading');

  return { files, addFiles, clearDone, retryFile, doneCount, dupCount, totalCount, activeCount, currentFile };
}
