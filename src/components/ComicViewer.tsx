import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, Sliders } from 'lucide-react';
import { downloadFileWithProgress } from '../utils/googleDrive';
import { decompressZip, decompressRar, revokeComicPages } from '../utils/decompress';
import type { ComicPage } from '../utils/decompress';
import { saveHistory, saveThumbnail, getThumbnail, historyStore, getCachedFile, cacheFile } from '../utils/db';
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

  // 閲覧用ステート
  const [currentPage, setCurrentPage] = useState<number>(0);
  const [showMenu, setShowMenu] = useState<boolean>(true);
  const [showSettings, setShowSettings] = useState<boolean>(false);

  // 閲覧設定
  const [direction, setDirection] = useState<ReadingDirection>(() => {
    return (localStorage.getItem('viewer_direction') as ReadingDirection) || 'rtl';
  });
  const [spreadMode, setSpreadMode] = useState<SpreadMode>(() => {
    return (localStorage.getItem('viewer_spread') as SpreadMode) || 'double';
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

  // ダブルタップ検出用
  const lastTapTime = useRef<number>(0);
  const lastTapPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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

  // ページが変わったらズームをリセット
  useEffect(() => {
    resetZoom();
  }, [currentPage, resetZoom]);

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

  // 履歴保存
  const saveReadingProgress = async (pageIndex: number, total: number) => {
    if (total <= 0) return;
    try {
      const progress = (pageIndex / (total - 1)) * 100;
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
  };

  // サムネイル生成・キャッシュ
  const generateAndCacheThumbnail = async (firstPageUrl: string) => {
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
  };

  // 漫画データのダウンロードと解凍
  useEffect(() => {
    let activePages: ComicPage[] = [];
    const loadComic = async () => {
      try {
        setError(null);
        let buffer: ArrayBuffer;
        const cachedBuffer = await getCachedFile(fileId);

        if (cachedBuffer) {
          setLoadingStep('cached');
          buffer = cachedBuffer;
        } else {
          setLoadingStep('downloading');
          buffer = await downloadFileWithProgress(fileId, (loaded, total) => {
            setDownloadProgress({ loaded, total });
          });
          cacheFile(fileId, buffer);
        }

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

        if (unzippedPages.length === 0) {
          throw new Error('解凍したファイル内に対応する画像が見つかりませんでした。');
        }

        activePages = unzippedPages;
        setPages(unzippedPages);
        setLoadingStep('ready');

        await saveReadingProgress(0, unzippedPages.length);
        const savedHist: any = await historyStore.getItem(fileId);
        if (savedHist && savedHist.currentPage < unzippedPages.length) {
          setCurrentPage(savedHist.currentPage);
        } else {
          setCurrentPage(0);
        }

        if (unzippedPages.length > 0) {
          generateAndCacheThumbnail(unzippedPages[0].url);
        }
      } catch (err: any) {
        setError(err.message || '漫画の読み込みに失敗しました。');
      }
    };

    loadComic();

    return () => {
      if (activePages.length > 0) {
        revokeComicPages(activePages);
      }
    };
  }, [fileId]);

  // ページ保存トリガー
  useEffect(() => {
    if (pages.length > 0) {
      saveReadingProgress(currentPage, pages.length);
    }
  }, [currentPage, pages]);

  const totalLength = pages.length;

  // 見開き表示のページ取得
  const getVisiblePages = (): number[] => {
    if (direction === 'vertical' || spreadMode === 'single' || !isLandscape) {
      return [currentPage];
    }
    if (currentPage === 0) return [0];
    if (currentPage % 2 === 1) {
      return [currentPage, currentPage + 1].filter(p => p < totalLength);
    } else {
      return [currentPage - 1, currentPage].filter(p => p < totalLength);
    }
  };

  // ページめくり
  const navigatePage = (action: 'next' | 'prev') => {
    if (totalLength === 0) return;
    let step = 1;
    if (direction !== 'vertical' && spreadMode === 'double' && isLandscape && currentPage > 0) {
      step = 2;
    }
    if (action === 'next') {
      setCurrentPage(prev => {
        if (step === 2 && prev === 0) return 1;
        return Math.min(prev + step, totalLength - 1);
      });
    } else {
      setCurrentPage(prev => {
        if (step === 2 && prev === 1) return 0;
        return Math.max(prev - step, 0);
      });
    }
  };

  // タップハンドラ（ズーム中はページ送り無効）
  const handleScreenTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    // ズーム中はタップによるページ送りを無効化
    if (scaleRef.current > 1.05) return;

    const width = window.innerWidth;
    const clickX = e.clientX;
    const sideWidth = width * 0.3;

    if (direction === 'vertical') {
      setShowMenu(prev => !prev);
      return;
    }

    if (clickX < sideWidth) {
      direction === 'rtl' ? navigatePage('next') : navigatePage('prev');
    } else if (clickX > width - sideWidth) {
      direction === 'rtl' ? navigatePage('prev') : navigatePage('next');
    } else {
      setShowMenu(prev => !prev);
    }
  };

  // === タッチイベント（ズーム・パン・スワイプ統合） ===
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // ピンチズーム開始
      isPinching.current = true;
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
        // ダブルタップ：ズームトグル
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
      const newDistance = getDistance(e.touches[0], e.touches[1]);
      const newMidpoint = getMidpoint(e.touches[0], e.touches[1]);

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
    } else if (e.touches.length === 1 && scaleRef.current > 1.05) {
      // ズーム中のパン
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - panStartPoint.current.x;
      const dy = touch.clientY - panStartPoint.current.y;
      const newPanX = panStartOffset.current.x + dx;
      const newPanY = panStartOffset.current.y + dy;
      panOffsetRef.current = { x: newPanX, y: newPanY };
      setPanOffset({ x: newPanX, y: newPanY });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isPinching.current) {
      isPinching.current = false;
      // ズームが1以下になったらリセット
      if (scaleRef.current <= 1.05) {
        resetZoom();
      }
      return;
    }

    // ズーム中はスワイプによるページ送りを無効
    if (scaleRef.current > 1.05) return;
    if (direction === 'vertical') return;

    const diffX = touchStartX.current - e.changedTouches[0].clientX;
    const diffY = touchStartY.current - e.changedTouches[0].clientY;

    if (Math.abs(diffY) > Math.abs(diffX)) return;

    const threshold = 50;
    if (Math.abs(diffX) > threshold) {
      if (diffX > 0) {
        direction === 'rtl' ? navigatePage('prev') : navigatePage('next');
      } else {
        direction === 'rtl' ? navigatePage('next') : navigatePage('prev');
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

  // ズーム変換スタイル
  const zoomTransform = (scale !== 1 || panOffset.x !== 0 || panOffset.y !== 0)
    ? `translate(${panOffset.x}px, ${panOffset.y}px) scale(${scale})`
    : undefined;

  return (
    <div className={styles.container} data-viewer-theme="dark">
      {/* メインビューエリア */}
      <div
        className={`${styles.viewport} ${direction === 'vertical' ? styles.verticalMode : ''}`}
        onClick={handleScreenTap}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ touchAction: scale > 1 ? 'none' : 'pan-y' }}
      >
        {direction === 'vertical' ? (
          // 縦スクロールモード
          <div className={styles.scrollWrapper}>
            {pages.map((page, idx) => (
              <img
                key={page.name}
                src={page.url}
                alt={`Page ${idx + 1}`}
                className={styles.scrollImage}
                loading={Math.abs(idx - currentPage) > 3 ? 'lazy' : 'eager'}
              />
            ))}
          </div>
        ) : (
          // スライドモード（単一・見開き）
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
              onChange={e => setCurrentPage(parseInt(e.target.value, 10))}
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
