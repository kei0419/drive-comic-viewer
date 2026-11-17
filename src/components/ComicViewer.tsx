import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, Sliders, RefreshCw } from 'lucide-react';
import { downloadFileWithProgress, AuthExpiredError, loginGoogle } from '../utils/googleDrive';
import { decompressZip, decompressRar, revokeComicPages } from '../utils/decompress';
import type { ComicPage } from '../utils/decompress';
import { saveHistory, saveThumbnail, getThumbnail, historyStore, getCachedFile, cacheFile } from '../utils/db';
import type { ReadingHistory } from '../utils/db';
import styles from '../styles/ComicViewer.module.css';

interface ComicViewerProps {
  fileId: string;
  comicName: string;
  onClose: () => void;
}

type ReadingDirection = 'rtl' | 'ltr' | 'vertical';
type SpreadMode = 'single' | 'double';

// 2点間の距離を計算
const getDistance = (t1: React.Touch, t2: React.Touch) => {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
};

// 2点の中心座標を取得
const getMidpoint = (t1: React.Touch, t2: React.Touch) => ({
  x: (t1.clientX + t2.clientX) / 2,
  y: (t1.clientY + t2.clientY) / 2,
});

export const ComicViewer: React.FC<ComicViewerProps> = ({
  fileId,
  comicName,
  onClose
}) => {
  // ローディングステート
  const [loadingStep, setLoadingStep] = useState<'downloading' | 'cached' | 'decompressing' | 'ready'>('downloading');
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);

  // 閲覧用ステート
  const [currentPage, setCurrentPage] = useState<number>(0);
  const currentPageRef = useRef<number>(0);
  const [showMenu, setShowMenu] = useState<boolean>(true);
  const [showSettings, setShowSettings] = useState<boolean>(false);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // 縦スクロール用Ref
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLImageElement | null)[]>([]);
  const isProgrammaticScrollRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<number | null>(null);

  // 閲覧設定
  const [direction, setDirection] = useState<ReadingDirection>(() => {
    return (localStorage.getItem('viewer_direction') as ReadingDirection) || 'rtl';
  });
  const [spreadMode, setSpreadMode] = useState<SpreadMode>(() => {
    return (localStorage.getItem('viewer_spread') as SpreadMode) || 'double';
  });
  // 見開き開始ページのズレ調整 (false: 奇数から開始, true: 偶数から開始)
  const [isSpreadOffset, setIsSpreadOffset] = useState<boolean>(() => {
    return localStorage.getItem('viewer_spread_offset') === 'true';
  });

  // ズーム・パン用ステート（描画用）
  const [scale, setScale] = useState<number>(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // ズーム・パン用Ref（タッチイベント中のリアルタイム追跡）
  const scaleRef = useRef<number>(1);
  const panOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastPinchDistance = useRef<number>(0);
  const lastPinchMidpoint = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const isPinching = useRef<boolean>(false);
  const panStartPoint = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panStartOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // ダブルタップ検出・誤タップ防止用
  const lastTapTime = useRef<number>(0);
  const lastTapPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const singleTapTimerRef = useRef<number | null>(null);
  const lastDoubleTapTimeRef = useRef<number>(0);
  const lastPinchTimeRef = useRef<number>(0);
  const didMoveOrPinchRef = useRef<boolean>(false);

  // スワイプ検出用（ズームなし時）
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);

  // 画面の向き
  const [isLandscape, setIsLandscape] = useState<boolean>(
    window.innerWidth > window.innerHeight
  );

  // ズームをリセット
  const resetZoom = useCallback(() => {
    scaleRef.current = 1;
    panOffsetRef.current = { x: 0, y: 0 };
    setScale(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // 縦スクロール時の指定ページジャンプ
  const scrollToPage = useCallback((pageIndex: number) => {
    const target = pageRefs.current[pageIndex];
    if (!target) return;
    isProgrammaticScrollRef.current = true;
    target.scrollIntoView({ block: 'start' });
    if (scrollTimeoutRef.current !== null) {
      window.clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = window.setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 150);
  }, []);

  // アンマウント時にタイマーを解放
  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
      }
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // 画面リサイズ検知
  useEffect(() => {
    const handleResize = () => {
      setIsLandscape(window.innerWidth > window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 設定変更時の保存
  const handleDirectionChange = (dir: ReadingDirection) => {
    resetZoom();
    setDirection(dir);
    localStorage.setItem('viewer_direction', dir);
    if (dir === 'vertical') {
      setShowSettings(false);
    }
  };

  const handleSpreadChange = (mode: SpreadMode) => {
    setSpreadMode(mode);
    localStorage.setItem('viewer_spread', mode);
  };

  const handleSpreadOffsetChange = (offset: boolean) => {
    setIsSpreadOffset(offset);
    localStorage.setItem('viewer_spread_offset', offset ? 'true' : 'false');
  };

  // 履歴保存
  const saveReadingProgress = useCallback(async (pageIndex: number, total: number) => {
    if (total <= 0) return;
    try {
      const progress = total === 1 ? 100 : (pageIndex / (total - 1)) * 100;
      await saveHistory({
        fileId,
        name: comicName,
        currentPage: pageIndex,
        totalPages: total,
        progress: isNaN(progress) ? 0 : progress,
        updatedAt: Date.now()
      });
    } catch (err) {
      console.error('Failed to save reading history:', err);
    }
  }, [fileId, comicName]);

  // サムネイル生成・キャッシュ
  const generateAndCacheThumbnail = useCallback(async (firstPageUrl: string) => {
    try {
      const cached = await getThumbnail(fileId);
      if (cached) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 120;
        const sc = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * sc;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const base64 = canvas.toDataURL('image/jpeg', 0.7);
          await saveThumbnail(fileId, base64);
        }
      };
      img.src = firstPageUrl;
    } catch (err) {
      console.error('Failed to generate thumbnail:', err);
    }
  }, [fileId]);

  // 漫画データのダウンロードと解凍
  useEffect(() => {
    let activePages: ComicPage[] = [];
    let isCancelled = false;

    const loadComic = async () => {
      try {
        setError(null);
        setIsAuthError(false);
        let buffer: ArrayBuffer;
        const cachedBuffer = await getCachedFile(fileId);

        if (cachedBuffer) {
          setLoadingStep('cached');
          buffer = cachedBuffer;
        } else {
          setLoadingStep('downloading');
          buffer = await downloadFileWithProgress(fileId, (loaded, total) => {
            if (!isCancelled) {
              setDownloadProgress({ loaded, total });
            }
          });
          await cacheFile(fileId, buffer);
        }

        if (isCancelled) return;

        setLoadingStep('decompressing');
        const lowerName = comicName.toLowerCase();
        let unzippedPages: ComicPage[] = [];

        if (lowerName.endsWith('.zip') || lowerName.endsWith('.cbz') || lowerName.includes('.zip') || lowerName.includes('.cbz')) {
          unzippedPages = await decompressZip(buffer);
        } else if (lowerName.endsWith('.rar') || lowerName.endsWith('.cbr') || lowerName.includes('.rar') || lowerName.includes('.cbr')) {
          unzippedPages = await decompressRar(buffer);
        } else {
          try {
            unzippedPages = await decompressZip(buffer);
          } catch {
            unzippedPages = await decompressRar(buffer);
          }
        }

        if (isCancelled) {
          revokeComicPages(unzippedPages);
          return;
        }

        if (unzippedPages.length === 0) {
          throw new Error('解凍したファイル内に対応する画像が見つかりませんでした。');
        }

        activePages = unzippedPages;
        pageRefs.current = [];

        // 先に保存済み履歴を取得し、0ページ目で上書きしないようにする
        const savedHist = await historyStore.getItem<ReadingHistory>(fileId);
        const initialPage =
          savedHist && savedHist.currentPage >= 0 && savedHist.currentPage < unzippedPages.length
            ? savedHist.currentPage
            : 0;

        resetZoom();
        currentPageRef.current = initialPage;
        setCurrentPage(initialPage);
        setPages(unzippedPages);
        setLoadingStep('ready');

        await saveReadingProgress(initialPage, unzippedPages.length);

        if (unzippedPages.length > 0) {
          void generateAndCacheThumbnail(unzippedPages[0].url);
        }
      } catch (err: unknown) {
        if (isCancelled) return;
        if (err instanceof AuthExpiredError) {
          setIsAuthError(true);
          setError(err.message);
        } else {
          setIsAuthError(false);
          setError(err instanceof Error ? err.message : '漫画の読み込みに失敗しました。');
        }
      }
    };

    void loadComic();

    return () => {
      isCancelled = true;
      if (activePages.length > 0) {
        revokeComicPages(activePages);
      }
    };
  }, [fileId, comicName, reloadKey, resetZoom, saveReadingProgress, generateAndCacheThumbnail]);

  // ページ保存トリガー（ロード完了後のみ実行）
  useEffect(() => {
    if (loadingStep === 'ready' && pages.length > 0) {
      void saveReadingProgress(currentPage, pages.length);
    }
  }, [loadingStep, currentPage, pages.length, saveReadingProgress]);

  // 縦スクロールモード表示時・切り替え時に現在ページへスクロール
  useEffect(() => {
    if (loadingStep === 'ready' && direction === 'vertical' && pages.length > 0) {
      const frameId = requestAnimationFrame(() => {
        scrollToPage(currentPageRef.current);
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [loadingStep, direction, pages.length, scrollToPage]);

  const handleReconnectAndRetry = async () => {
    try {
      await loginGoogle();
      setIsAuthError(false);
      setError(null);
      setLoadingStep('downloading');
      setReloadKey(prev => prev + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Googleドライブへの再接続に失敗しました。');
    }
  };

  const totalLength = pages.length;

  // 見開き表示のページ取得
  const getVisiblePages = (): number[] => {
    if (direction === 'vertical' || spreadMode === 'single' || !isLandscape) {
      return [currentPage];
    }
    
    let currentSpread: number[];
    if (isSpreadOffset) {
      // 偶数（表紙0を含む）からペアにする
      if (currentPage % 2 === 0) {
        currentSpread = [currentPage, currentPage + 1].filter(p => p < totalLength);
      } else {
        currentSpread = [currentPage - 1, currentPage].filter(p => p < totalLength);
      }
    } else {
      // 通常：0（表紙）は単独、1以降は奇数からペアにする
      if (currentPage === 0) return [0];
      if (currentPage % 2 === 1) {
        currentSpread = [currentPage, currentPage + 1].filter(p => p < totalLength);
      } else {
        currentSpread = [currentPage - 1, currentPage].filter(p => p < totalLength);
      }
    }

    // 右開き(RTL)の場合は、右側に若いページ（インデックスが小さい方）を表示するため、配列を左右反転する
    if (direction === 'rtl') {
      return [...currentSpread].reverse();
    }
    return currentSpread;
  };

  // ページめくり
  const navigatePage = (action: 'next' | 'prev') => {
    if (totalLength === 0) return;
    resetZoom();
    let step = 1;
    if (direction !== 'vertical' && spreadMode === 'double' && isLandscape) {
      if (isSpreadOffset) {
        step = 2;
      } else {
        if (currentPage > 0) {
          step = 2;
        }
      }
    }
    
    if (action === 'next') {
      setCurrentPage(prev => {
        if (step === 2 && !isSpreadOffset && prev === 0) return 1;
        return Math.min(prev + step, totalLength - 1);
      });
    } else {
      setCurrentPage(prev => {
        if (step === 2 && !isSpreadOffset && prev === 1) return 0;
        return Math.max(prev - step, 0);
      });
    }
  };

  // 縦スクロール時の現在ページ算出
  const handleViewportScroll = () => {
    if (direction !== 'vertical' || isProgrammaticScrollRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport || pages.length === 0) return;

    const viewportRect = viewport.getBoundingClientRect();
    const viewportCenterY = viewportRect.top + viewportRect.height / 2;

    let closestIndex = currentPageRef.current;
    let closestDistance = Infinity;

    for (let i = 0; i < pages.length; i++) {
      const el = pageRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= viewportCenterY && rect.bottom >= viewportCenterY) {
        closestIndex = i;
        break;
      }
      const elCenterY = rect.top + rect.height / 2;
      const dist = Math.abs(elCenterY - viewportCenterY);
      if (dist < closestDistance) {
        closestDistance = dist;
        closestIndex = i;
      }
    }

    if (closestIndex !== currentPageRef.current) {
      currentPageRef.current = closestIndex;
      setCurrentPage(closestIndex);
    }
  };

  // タップハンドラ（ズーム中・ダブルタップ・ピンチ/スワイプ直後は無効、シングルタップは遅延実行）
  const handleScreenTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    if (Date.now() - lastDoubleTapTimeRef.current < 400) {
      return;
    }
    if (didMoveOrPinchRef.current) {
      didMoveOrPinchRef.current = false;
      return;
    }
    // ズーム中はタップによるページ送りを無効化
    if (scaleRef.current > 1.05) return;

    const width = window.innerWidth;
    const clickX = e.clientX;
    const sideWidth = width * 0.3;

    if (singleTapTimerRef.current !== null) {
      window.clearTimeout(singleTapTimerRef.current);
    }

    singleTapTimerRef.current = window.setTimeout(() => {
      singleTapTimerRef.current = null;
      if (Date.now() - lastDoubleTapTimeRef.current < 400) return;
      if (scaleRef.current > 1.05) return;

      if (direction === 'vertical') {
        setShowMenu(prev => !prev);
        return;
      }

      if (clickX < sideWidth) {
        navigatePage(direction === 'rtl' ? 'next' : 'prev');
      } else if (clickX > width - sideWidth) {
        navigatePage(direction === 'rtl' ? 'prev' : 'next');
      } else {
        setShowMenu(prev => !prev);
      }
    }, 260);
  };

  // === タッチイベント（ズーム・パン・スワイプ統合） ===
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // ピンチズーム開始
      isPinching.current = true;
      lastPinchTimeRef.current = Date.now();
      didMoveOrPinchRef.current = true;
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastPinchDistance.current = getDistance(e.touches[0], e.touches[1]);
      lastPinchMidpoint.current = getMidpoint(e.touches[0], e.touches[1]);
    } else if (e.touches.length === 1) {
      isPinching.current = false;
      const touch = e.touches[0];

      // ダブルタップ検出
      const now = Date.now();
      const timeDiff = now - lastTapTime.current;
      const dx = touch.clientX - lastTapPos.current.x;
      const dy = touch.clientY - lastTapPos.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (timeDiff < 300 && dist < 40) {
        // ダブルタップ：遅延シングルタップを抑止してズームトグル
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastDoubleTapTimeRef.current = now;
        didMoveOrPinchRef.current = true;

        if (scaleRef.current > 1.05) {
          resetZoom();
        } else {
          const newScale = 2.5;
          const viewW = window.innerWidth;
          const viewH = window.innerHeight;
          // タップ位置を中心にズーム
          const newPanX = (viewW / 2 - touch.clientX) * (newScale - 1);
          const newPanY = (viewH / 2 - touch.clientY) * (newScale - 1);
          scaleRef.current = newScale;
          panOffsetRef.current = { x: newPanX, y: newPanY };
          setScale(newScale);
          setPanOffset({ x: newPanX, y: newPanY });
        }
        lastTapTime.current = 0;
        return;
      }

      didMoveOrPinchRef.current = false;
      lastTapTime.current = now;
      lastTapPos.current = { x: touch.clientX, y: touch.clientY };

      // パン or スワイプ開始
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      panStartPoint.current = { x: touch.clientX, y: touch.clientY };
      panStartOffset.current = { ...panOffsetRef.current };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // ピンチズーム処理
      e.preventDefault();
      lastPinchTimeRef.current = Date.now();
      didMoveOrPinchRef.current = true;
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }

      const newDistance = getDistance(e.touches[0], e.touches[1]);
      const newMidpoint = getMidpoint(e.touches[0], e.touches[1]);
      if (lastPinchDistance.current <= 0) {
        lastPinchDistance.current = newDistance;
        lastPinchMidpoint.current = newMidpoint;
        return;
      }

      const distRatio = newDistance / lastPinchDistance.current;
      const newScale = Math.min(Math.max(scaleRef.current * distRatio, 1), 5);

      // ピンチ中心を基準にパンを調整
      const dx = newMidpoint.x - lastPinchMidpoint.current.x;
      const dy = newMidpoint.y - lastPinchMidpoint.current.y;
      const newPanX = panOffsetRef.current.x + dx;
      const newPanY = panOffsetRef.current.y + dy;

      scaleRef.current = newScale;
      panOffsetRef.current = { x: newPanX, y: newPanY };
      setScale(newScale);
      setPanOffset({ x: newPanX, y: newPanY });

      lastPinchDistance.current = newDistance;
      lastPinchMidpoint.current = newMidpoint;
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      const moveDist = Math.hypot(
        touch.clientX - touchStartX.current,
        touch.clientY - touchStartY.current
      );
      if (moveDist > 10) {
        didMoveOrPinchRef.current = true;
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
      }

      if (scaleRef.current > 1.05) {
        // ズーム中のパン
        e.preventDefault();
        const dx = touch.clientX - panStartPoint.current.x;
        const dy = touch.clientY - panStartPoint.current.y;
        const newPanX = panStartOffset.current.x + dx;
        const newPanY = panStartOffset.current.y + dy;
        panOffsetRef.current = { x: newPanX, y: newPanY };
        setPanOffset({ x: newPanX, y: newPanY });
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isPinching.current) {
      lastPinchTimeRef.current = Date.now();
      if (e.touches.length === 0) {
        isPinching.current = false;
        // ズームが1以下になったらリセット
        if (scaleRef.current <= 1.05) {
          resetZoom();
        }
      }
      return;
    }

    if (Date.now() - lastDoubleTapTimeRef.current < 400) return;
    if (Date.now() - lastPinchTimeRef.current < 300) return;

    // ズーム中はスワイプによるページ送りを無効
    if (scaleRef.current > 1.05) return;
    if (direction === 'vertical') return;

    const diffX = touchStartX.current - e.changedTouches[0].clientX;
    const diffY = touchStartY.current - e.changedTouches[0].clientY;

    if (Math.abs(diffY) > Math.abs(diffX)) return;

    const threshold = 50;
    if (Math.abs(diffX) > threshold) {
      if (diffX > 0) {
        navigatePage(direction === 'rtl' ? 'prev' : 'next');
      } else {
        navigatePage(direction === 'rtl' ? 'next' : 'prev');
      }
    }
  };

  // ローディング画面
  if (loadingStep !== 'ready') {
    const loadedMB = (downloadProgress.loaded / 1024 / 1024).toFixed(1);
    const totalMB = (downloadProgress.total / 1024 / 1024).toFixed(1);
    const percent = downloadProgress.total > 0
      ? Math.round((downloadProgress.loaded / downloadProgress.total) * 100)
      : 0;

    const statusMessage = loadingStep === 'cached'
      ? 'キャッシュから読み込み中...'
      : loadingStep === 'downloading'
        ? 'Googleドライブからダウンロード中...'
        : 'アーカイブを解凍中...';

    return (
      <div className={styles.loadingContainer}>
        <div className={`glass-panel ${styles.loadingCard}`}>
          {error ? (
            <div className={styles.errorWrapper}>
              <p className={styles.errorText}>{error}</p>
              <div className={styles.errorActions}>
                {isAuthError && (
                  <button className="btn-primary" onClick={handleReconnectAndRetry}>
                    <RefreshCw size={16} />
                    Googleドライブに再接続して再試行
                  </button>
                )}
                <button className="btn-secondary" onClick={onClose}>
                  本棚に戻る
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.progressWrapper}>
              <div className="spinner" />
              <p className={styles.statusText}>{statusMessage}</p>
              {loadingStep === 'downloading' && (
                <div className={styles.progressInfo}>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${percent}%` }} />
                  </div>
                  <span className={styles.progressPercent}>
                    {percent}% ({loadedMB} MB / {totalMB} MB)
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const visiblePages = getVisiblePages();
  const visibleMin = visiblePages.length > 0 ? Math.min(...visiblePages) : currentPage;
  const visibleMax = visiblePages.length > 0 ? Math.max(...visiblePages) : currentPage;
  const preloadPages = direction !== 'vertical'
    ? [visibleMin - 1, visibleMax + 1, visibleMax + 2].filter(
        idx => idx >= 0 && idx < totalLength && !visiblePages.includes(idx)
      )
    : [];

  // ズーム変換スタイル
  const zoomTransform = (scale !== 1 || panOffset.x !== 0 || panOffset.y !== 0)
    ? `translate(${panOffset.x}px, ${panOffset.y}px) scale(${scale})`
    : undefined;

  return (
    <div className={styles.container} data-viewer-theme="dark">
      {/* メインビューエリア */}
      <div
        ref={viewportRef}
        className={`${styles.viewport} ${direction === 'vertical' ? styles.verticalMode : ''}`}
        onClick={handleScreenTap}
        onScroll={handleViewportScroll}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ touchAction: direction !== 'vertical' ? 'none' : (scale > 1 ? 'none' : 'pan-y') }}
      >
        {direction === 'vertical' ? (
          // 縦スクロールモード
          <div className={styles.scrollWrapper}>
            {pages.map((page, idx) => (
              <img
                key={page.name}
                ref={el => { pageRefs.current[idx] = el; }}
                src={page.url}
                alt={`Page ${idx + 1}`}
                className={styles.scrollImage}
                loading={Math.abs(idx - currentPage) > 3 ? 'lazy' : 'eager'}
              />
            ))}
          </div>
        ) : (
          // スライドモード（単一・見開き）
          <>
            <div
              className={styles.spreadWrapper}
              style={zoomTransform
                ? { transform: zoomTransform, transformOrigin: 'center center', willChange: 'transform' }
                : undefined}
            >
              {visiblePages.map((pageIdx) => (
                <div key={pages[pageIdx].name} className={styles.pageContainer}>
                  <img
                    src={pages[pageIdx].url}
                    alt={`Page ${pageIdx + 1}`}
                    className={styles.pageImage}
                    draggable={false}
                  />
                </div>
              ))}
            </div>
            {preloadPages.length > 0 && (
              <div className={styles.preloadContainer} aria-hidden="true">
                {preloadPages.map(pageIdx => (
                  <img
                    key={`preload-${pages[pageIdx].name}`}
                    src={pages[pageIdx].url}
                    alt=""
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ズームインジケーター */}
      {scale > 1.05 && (
        <div className={styles.zoomIndicator}>
          {scale.toFixed(1)}×
        </div>
      )}

      {/* ヘッダーメニュー */}
      <header className={`${styles.header} ${showMenu ? styles.show : ''} glass-panel`}>
        <button className={styles.backBtn} onClick={onClose} aria-label="本棚に戻る">
          <ChevronLeft size={24} />
        </button>
        <h2 className={styles.title} title={comicName}>{comicName}</h2>
        <div style={{ width: 40 }} />
      </header>

      {/* 設定ポップアップ */}
      <div className={`${styles.settingsPanel} ${showSettings ? styles.show : ''} glass-panel`}>
        <h3 className={styles.settingsTitle}>読書設定</h3>

        <div className={styles.settingGroup}>
          <span className={styles.settingLabel}>ページめくり方向</span>
          <div className={styles.settingOptions}>
            <button
              className={`${styles.optionBtn} ${direction === 'rtl' ? styles.active : ''}`}
              onClick={() => handleDirectionChange('rtl')}
            >
              右開き (日本のマンガ)
            </button>
            <button
              className={`${styles.optionBtn} ${direction === 'ltr' ? styles.active : ''}`}
              onClick={() => handleDirectionChange('ltr')}
            >
              左開き (資料・洋書)
            </button>
            <button
              className={`${styles.optionBtn} ${direction === 'vertical' ? styles.active : ''}`}
              onClick={() => handleDirectionChange('vertical')}
            >
              縦スクロール
            </button>
          </div>
        </div>

        {direction !== 'vertical' && (
          <div className={styles.settingGroup}>
            <span className={styles.settingLabel}>見開き表示 (横画面時)</span>
            <div className={styles.settingOptions}>
              <button
                className={`${styles.optionBtn} ${spreadMode === 'double' ? styles.active : ''}`}
                onClick={() => handleSpreadChange('double')}
              >
                見開きON
              </button>
              <button
                className={`${styles.optionBtn} ${spreadMode === 'single' ? styles.active : ''}`}
                onClick={() => handleSpreadChange('single')}
              >
                1ページ固定
              </button>
            </div>
          </div>
        )}

        {direction !== 'vertical' && spreadMode === 'double' && (
          <div className={styles.settingGroup}>
            <span className={styles.settingLabel}>見開きの左右ズレ調整</span>
            <div className={styles.settingOptions}>
              <button
                className={`${styles.optionBtn} ${!isSpreadOffset ? styles.active : ''}`}
                onClick={() => handleSpreadOffsetChange(false)}
              >
                調整なし (標準)
              </button>
              <button
                className={`${styles.optionBtn} ${isSpreadOffset ? styles.active : ''}`}
                onClick={() => handleSpreadOffsetChange(true)}
              >
                1ページずらす (補正ON)
              </button>
            </div>
          </div>
        )}
      </div>

      {/* フッター操作バー */}
      <footer className={`${styles.footer} ${showMenu ? styles.show : ''} glass-panel`}>
        <div className={styles.footerControls}>
          <span className={styles.pageIndicator}>
            {currentPage + 1} / {totalLength} ページ
          </span>

          <div className={styles.sliderWrapper} onClick={e => e.stopPropagation()}>
            <input
              type="range"
              min={0}
              max={totalLength - 1}
              value={currentPage}
              onChange={e => {
                const nextPage = parseInt(e.target.value, 10);
                resetZoom();
                setCurrentPage(nextPage);
                if (direction === 'vertical') {
                  requestAnimationFrame(() => scrollToPage(nextPage));
                }
              }}
              className={styles.seekBar}
              style={{ direction: direction === 'rtl' ? 'rtl' : 'ltr' }}
            />
          </div>

          <button
            className={`${styles.settingsBtn} ${showSettings ? styles.activeBtn : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}
            title="設定"
          >
            <Sliders size={20} />
          </button>
        </div>
      </footer>
    </div>
  );
};
