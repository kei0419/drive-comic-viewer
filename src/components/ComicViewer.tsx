import React, { useState, useEffect, useRef } from 'react';
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
  
  // 閲覧設定 (localStorageから読み込む、デフォルトは日本の漫画用に 'rtl', 'double')
  const [direction, setDirection] = useState<ReadingDirection>(() => {
    return (localStorage.getItem('viewer_direction') as ReadingDirection) || 'rtl';
  });
  const [spreadMode, setSpreadMode] = useState<SpreadMode>(() => {
    return (localStorage.getItem('viewer_spread') as SpreadMode) || 'double';
  });

  // スワイプ検出用
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);
  
  // 画面の向き (見開き判定用)
  const [isLandscape, setIsLandscape] = useState<boolean>(
    window.innerWidth > window.innerHeight
  );

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
    // 縦スクロールに変更された場合、メニューの自動非表示など調整
    if (dir === 'vertical') {
      setShowSettings(false);
    }
  };

  const handleSpreadChange = (mode: SpreadMode) => {
    setSpreadMode(mode);
    localStorage.setItem('viewer_spread', mode);
  };

  // 履歴保存の自動化
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

  // サムネイルの自動生成とキャッシュ
  const generateAndCacheThumbnail = async (firstPageUrl: string) => {
    try {
      // 既にキャッシュがあればスキップ
      const cached = await getThumbnail(fileId);
      if (cached) return;

      // キャンバスを使用してリサイズされたBase64画像を生成
      const img = new Image();
      img.crossOrigin = 'anonymous'; // CORS対策
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 120; // サムネイルサイズ
        const scale = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scale;

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

        // 1. キャッシュを確認
        let buffer: ArrayBuffer;
        const cachedBuffer = await getCachedFile(fileId);
        
        if (cachedBuffer) {
          // キャッシュヒット！ダウンロード不要
          setLoadingStep('cached');
          buffer = cachedBuffer;
        } else {
          // キャッシュなし → Googleドライブからダウンロード
          setLoadingStep('downloading');
          buffer = await downloadFileWithProgress(fileId, (loaded, total) => {
            setDownloadProgress({ loaded, total });
          });
          // ダウンロード完了後にキャッシュに保存（バックグラウンド）
          cacheFile(fileId, buffer);
        }

        // 2. 解凍
        setLoadingStep('decompressing');
        const lowerName = comicName.toLowerCase();
        let unzippedPages: ComicPage[] = [];

        if (lowerName.endsWith('.zip') || lowerName.endsWith('.cbz') || lowerName.includes('.zip') || lowerName.includes('.cbz')) {
          unzippedPages = await decompressZip(buffer);
        } else if (lowerName.endsWith('.rar') || lowerName.endsWith('.cbr') || lowerName.includes('.rar') || lowerName.includes('.cbr')) {
          unzippedPages = await decompressRar(buffer);
        } else {
          // 拡張子判別できない場合はzipとして試す
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

        // 3. 履歴から前回の読み込み位置を取得して遷移
        await saveReadingProgress(0, unzippedPages.length); // ダミー保存を兼ねて初期化
        // 実際には履歴データベースから読み込み位置を決定する
        const savedHist: any = await historyStore.getItem(fileId);
        if (savedHist && savedHist.currentPage < unzippedPages.length) {
          setCurrentPage(savedHist.currentPage);
        } else {
          setCurrentPage(0);
        }

        // 4. サムネイルの自動生成
        if (unzippedPages.length > 0) {
          generateAndCacheThumbnail(unzippedPages[0].url);
        }
      } catch (err: any) {
        setError(err.message || '漫画の読み込みに失敗しました。');
      }
    };

    loadComic();

    // クリーンアップ
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

  // 進捗率の計算用
  const totalLength = pages.length;

  // 見開き表示の場合のページ取得
  const getVisiblePages = (): number[] => {
    if (direction === 'vertical' || spreadMode === 'single' || !isLandscape) {
      return [currentPage];
    }
    // 表紙（0ページ目）は単一表示
    if (currentPage === 0) {
      return [0];
    }
    // 奇数ページ目が現在の位置の場合、その前（偶数）と並べる
    if (currentPage % 2 === 1) {
      return [currentPage, currentPage + 1].filter(p => p < totalLength);
    } else {
      return [currentPage - 1, currentPage].filter(p => p < totalLength);
    }
  };

  // ページめくり処理
  const navigatePage = (action: 'next' | 'prev') => {
    if (totalLength === 0) return;

    let step = 1;
    // 見開き表示の場合は2ページ進める
    if (direction !== 'vertical' && spreadMode === 'double' && isLandscape && currentPage > 0) {
      step = 2;
    }

    if (action === 'next') {
      setCurrentPage(prev => {
        // 見開きの端数の処理
        if (step === 2 && prev === 0) return 1; // 表紙の次は1ページ目
        const next = Math.min(prev + step, totalLength - 1);
        return next;
      });
    } else {
      setCurrentPage(prev => {
        if (step === 2 && prev === 1) return 0; // 1ページ目の前は表紙
        const next = Math.max(prev - step, 0);
        return next;
      });
    }
  };

  // タップハンドラ（画面左右のタップでめくる）
  const handleScreenTap = (e: React.MouseEvent<HTMLDivElement>) => {
    // 設定メニューが開いている場合は設定メニューを閉じる
    if (showSettings) {
      setShowSettings(false);
      return;
    }

    const width = window.innerWidth;
    const clickX = e.clientX;
    const sideWidth = width * 0.3; // 左右30%をタップエリアにする

    if (direction === 'vertical') {
      // 縦スクロールモードはタップでメニュー切り替えのみ
      setShowMenu(!showMenu);
      return;
    }

    if (clickX < sideWidth) {
      // 左側タップ
      if (direction === 'rtl') {
        navigatePage('next'); // 右開きなら左タップで進む
      } else {
        navigatePage('prev'); // 左開きなら左タップで戻る
      }
    } else if (clickX > width - sideWidth) {
      // 右側タップ
      if (direction === 'rtl') {
        navigatePage('prev'); // 右開きなら右タップで戻る
      } else {
        navigatePage('next'); // 左開きなら右タップで進む
      }
    } else {
      // 中央タップでメニューの開閉
      setShowMenu(!showMenu);
    }
  };

  // スワイプイベント処理
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (direction === 'vertical') return; // 縦スクロールはスワイプ判定しない
    
    const diffX = touchStartX.current - e.changedTouches[0].clientX;
    const diffY = touchStartY.current - e.changedTouches[0].clientY;
    
    // 縦に大きくスワイプした場合は除外
    if (Math.abs(diffY) > Math.abs(diffX)) return;

    const threshold = 50; // スワイプと判定するピクセル数
    if (Math.abs(diffX) > threshold) {
      if (diffX > 0) {
        // 右から左へのスワイプ
        direction === 'rtl' ? navigatePage('prev') : navigatePage('next');
      } else {
        // 左から右へのスワイプ
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
              <p className={styles.statusText}>
                {statusMessage}
              </p>
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

  return (
    <div className={styles.container} data-viewer-theme="dark">
      {/* メインビューエリア */}
      <div 
        className={`${styles.viewport} ${direction === 'vertical' ? styles.verticalMode : ''}`}
        onClick={handleScreenTap}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
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
                loading={Math.abs(idx - currentPage) > 3 ? "lazy" : "eager"}
              />
            ))}
          </div>
        ) : (
          // スライドモード（単一・見開き）
          <div className={styles.spreadWrapper}>
            {visiblePages.map((pageIdx) => (
              <div key={pages[pageIdx].name} className={styles.pageContainer}>
                <img 
                  src={pages[pageIdx].url} 
                  alt={`Page ${pageIdx + 1}`} 
                  className={styles.pageImage} 
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ヘッダーメニュー */}
      <header className={`${styles.header} ${showMenu ? styles.show : ''} glass-panel`}>
        <button className={styles.backBtn} onClick={onClose} aria-label="本棚に戻る">
          <ChevronLeft size={24} />
        </button>
        <h2 className={styles.title} title={comicName}>{comicName}</h2>
        <div style={{ width: 40 }} /> {/* レイアウト用スペーサー */}
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
          
          {/* シークスライダー */}
          <div className={styles.sliderWrapper} onClick={e => e.stopPropagation()}>
            <input 
              type="range" 
              min={0} 
              max={totalLength - 1} 
              value={currentPage}
              onChange={e => setCurrentPage(parseInt(e.target.value, 10))}
              className={styles.seekBar}
              style={{ direction: direction === 'rtl' ? 'rtl' : 'ltr' }} // スライダーの進行方向をめくり方向に合わせる
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
