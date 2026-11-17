import React, { useState, useEffect } from 'react';
import { 
  Folder, FileArchive, Star, History, ChevronRight, 
  LogOut, Settings, Sun, Moon, RefreshCw, BookOpen 
} from 'lucide-react';
import { 
  listDriveContents, formatBytes, AuthExpiredError, loginGoogle 
} from '../utils/googleDrive';
import type { DriveItem } from '../utils/googleDrive';
import { 
  getHistory, getFavorites, addFavorite, removeFavorite, 
  isFavorite, getThumbnail 
} from '../utils/db';
import type { ReadingHistory, FavoriteItem, FavoritePathNode } from '../utils/db';
import styles from '../styles/FileBrowser.module.css';

interface FileBrowserProps {
  currentFolderId: string;
  path: FavoritePathNode[];
  onChangeFolder: (folderId: string, nextPath: FavoritePathNode[]) => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  onSelectComic: (fileId: string, name: string) => void;
  theme: 'light' | 'dark';
  onChangeTheme: (theme: 'light' | 'dark') => void;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  currentFolderId,
  path,
  onChangeFolder,
  onLogout,
  onOpenSettings,
  onSelectComic,
  theme,
  onChangeTheme
}) => {
  const [items, setItems] = useState<DriveItem[]>([]);
  
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState<boolean>(false);

  // 履歴とお気に入り
  const [histories, setHistories] = useState<ReadingHistory[]>([]);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favoriteStatusMap, setFavoriteStatusMap] = useState<Record<string, boolean>>({});
  
  // サムネイルキャッシュ
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  // 履歴とお気に入りをロード
  const loadHistoryAndFavorites = async () => {
    try {
      const hist = await getHistory();
      setHistories(hist.slice(0, 4)); // 最大4件を表示

      const favs = await getFavorites();
      setFavorites(favs);

      // サムネイルのロード
      const thumbMap: Record<string, string> = {};
      for (const h of hist) {
        const thumb = await getThumbnail(h.fileId);
        if (thumb) thumbMap[h.fileId] = thumb;
      }
      for (const f of favs) {
        const thumb = await getThumbnail(f.id);
        if (thumb) thumbMap[f.id] = thumb;
      }
      setThumbnails(prev => ({ ...prev, ...thumbMap }));
    } catch (err) {
      console.error('Failed to load history or favorites:', err);
    }
  };

  // ドライブコンテンツのロード
  const loadContents = async (folderId: string) => {
    setLoading(true);
    setError(null);
    setIsAuthError(false);
    try {
      const contents = await listDriveContents(folderId);
      setItems(contents);

      // 各アイテムのお気に入り状況をマッピング
      const statusMap: Record<string, boolean> = {};
      for (const item of contents) {
        statusMap[item.id] = await isFavorite(item.id);
      }
      setFavoriteStatusMap(statusMap);

      // コンテンツ内のサムネイルをロード
      const thumbMap: Record<string, string> = {};
      for (const item of contents) {
        const thumb = await getThumbnail(item.id);
        if (thumb) thumbMap[item.id] = thumb;
      }
      setThumbnails(prev => ({ ...prev, ...thumbMap }));
    } catch (err: unknown) {
      if (err instanceof AuthExpiredError) {
        setIsAuthError(true);
        setError(err.message);
      } else {
        setIsAuthError(false);
        setError(err instanceof Error ? err.message : 'コンテンツの読み込みに失敗しました。');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleReconnectAndRetry = async () => {
    try {
      await loginGoogle();
      await loadContents(currentFolderId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Googleドライブへの再接続に失敗しました。');
    }
  };

  useEffect(() => {
    loadHistoryAndFavorites();
    loadContents(currentFolderId);
  }, [currentFolderId]);

  // フォルダ移動
  const handleFolderClick = async (folderId: string, folderName: string) => {
    const existingIndex = path.findIndex(node => node.id === folderId);
    const nextPath = existingIndex !== -1
      ? path.slice(0, existingIndex + 1)
      : [...path, { id: folderId, name: folderName }];
    onChangeFolder(folderId, nextPath);
  };

  // お気に入りフォルダへの移動（パンくずリストを破壊せず復元/リセットする）
  const handleFavoriteFolderClick = (fav: FavoriteItem) => {
    let nextPath: FavoritePathNode[];
    if (fav.path && fav.path.length > 0) {
      nextPath = fav.path;
    } else if (fav.id === 'root') {
      nextPath = [{ id: 'root', name: 'マイドライブ' }];
    } else {
      nextPath = [
        { id: 'root', name: 'マイドライブ' },
        { id: fav.id, name: fav.name }
      ];
    }
    onChangeFolder(fav.id, nextPath);
  };

  const handleBreadcrumbClick = (_node: FavoritePathNode, index: number) => {
    const nextPath = path.slice(0, index + 1);
    onChangeFolder(nextPath[nextPath.length - 1].id, nextPath);
  };

  // お気に入りトグル
  const handleToggleFavorite = async (e: React.MouseEvent, item: DriveItem | FavoriteItem, isFolder: boolean) => {
    e.stopPropagation();
    const id = item.id;
    const currentlyFav = favoriteStatusMap[id] || favorites.some(f => f.id === id);

    if (currentlyFav) {
      await removeFavorite(id);
      setFavoriteStatusMap(prev => ({ ...prev, [id]: false }));
    } else {
      const existingPath = 'path' in item ? item.path : undefined;
      const itemPath: FavoritePathNode[] = existingPath && existingPath.length > 0
        ? existingPath
        : isFolder
          ? [...path, { id, name: item.name }]
          : [...path];

      const favItem: FavoriteItem = {
        id,
        name: item.name,
        isFolder,
        parentId: currentFolderId,
        path: itemPath,
        addedAt: Date.now()
      };
      await addFavorite(favItem);
      setFavoriteStatusMap(prev => ({ ...prev, [id]: true }));
    }
    loadHistoryAndFavorites();
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    onChangeTheme(nextTheme);
  };

  return (
    <div className={styles.container}>
      {/* ヘッダー */}
      <header className={`glass-panel ${styles.header}`}>
        <div className={styles.brand}>
          <span className={styles.logo}>🔮</span>
          <h1 className={styles.brandName}>Cloud Comic Reader</h1>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.iconBtn} onClick={toggleTheme} title="テーマ切り替え">
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button className={styles.iconBtn} onClick={onOpenSettings} title="設定">
            <Settings size={20} />
          </button>
          <button className={`${styles.iconBtn} ${styles.logout}`} onClick={onLogout} title="接続を解除">
            <LogOut size={20} />
          </button>
        </div>
      </header>

      {/* メインエリア */}
      <main className={styles.main}>
        {/* サイドバー: 最近読んだ本 & お気に入り */}
        <section className={styles.sidebar}>
          {/* 最近読んだ本 */}
          <div className={`glass-panel ${styles.sideCard}`}>
            <h2 className={styles.sectionTitle}>
              <History size={18} className={styles.titleIcon} />
              最近読んだ本
            </h2>
            {histories.length === 0 ? (
              <p className={styles.emptyText}>読書履歴はありません。</p>
            ) : (
              <div className={styles.historyGrid}>
                {histories.map(h => (
                  <div key={h.fileId} className={styles.historyCard} onClick={() => onSelectComic(h.fileId, h.name)}>
                    <div className={styles.thumbnailWrapper}>
                      {thumbnails[h.fileId] ? (
                        <img src={thumbnails[h.fileId]} alt={h.name} className={styles.thumbnail} />
                      ) : (
                        <div className={styles.thumbnailPlaceholder}>
                          <BookOpen size={30} />
                        </div>
                      )}
                      <div className={styles.historyProgress}>
                        <div className={styles.progressBar} style={{ width: `${h.progress}%` }} />
                      </div>
                    </div>
                    <div className={styles.historyInfo}>
                      <span className={styles.historyTitle}>{h.name}</span>
                      <span className={styles.historyMeta}>
                        {h.currentPage + 1} / {h.totalPages} p ({Math.round(h.progress)}%)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* お気に入りフォルダ・ファイル */}
          <div className={`glass-panel ${styles.sideCard}`}>
            <h2 className={styles.sectionTitle}>
              <Star size={18} className={styles.titleIconFav} />
              お気に入り
            </h2>
            {favorites.length === 0 ? (
              <p className={styles.emptyText}>お気に入りはありません。</p>
            ) : (
              <div className={styles.favList}>
                {favorites.map(f => (
                  <div 
                    key={f.id} 
                    className={styles.favItem}
                    onClick={() => f.isFolder ? handleFavoriteFolderClick(f) : onSelectComic(f.id, f.name)}
                  >
                    {f.isFolder ? <Folder size={18} className={styles.folderIcon} /> : <FileArchive size={18} className={styles.fileIcon} />}
                    <span className={styles.favName}>{f.name}</span>
                    <button 
                      className={styles.favStarBtnActive}
                      onClick={(e) => handleToggleFavorite(e, f, f.isFolder)}
                      aria-label="お気に入り解除"
                    >
                      <Star size={16} fill="currentColor" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* フォルダエクスプローラー */}
        <section className={`glass-panel ${styles.explorer}`}>
          {/* パンくずナビゲーション */}
          <div className={styles.breadcrumb}>
            {path.map((node, index) => (
              <React.Fragment key={node.id}>
                {index > 0 && <ChevronRight size={14} className={styles.separator} />}
                <button 
                  className={styles.breadcrumbNode}
                  onClick={() => handleBreadcrumbClick(node, index)}
                >
                  {node.name}
                </button>
              </React.Fragment>
            ))}
          </div>

          {/* リスト・グリッド表示 */}
          <div className={styles.explorerBody}>
            {loading ? (
              <div className={styles.loadingArea}>
                <div className="spinner" />
                <p className={styles.loadingText}>Googleドライブから読み込み中...</p>
              </div>
            ) : error ? (
              <div className={styles.errorArea}>
                <p className={styles.errorText}>{error}</p>
                {isAuthError ? (
                  <button className="btn-primary" onClick={handleReconnectAndRetry}>
                    <RefreshCw size={16} />
                    Googleドライブに再接続して再試行
                  </button>
                ) : (
                  <button className="btn-primary" onClick={() => loadContents(currentFolderId)}>
                    <RefreshCw size={16} />
                    再試行
                  </button>
                )}
              </div>
            ) : items.length === 0 ? (
              <div className={styles.emptyArea}>
                <Folder size={44} className={styles.emptyIcon} />
                <p>フォルダ内に zip / rar 形式の漫画ファイルがありません。</p>
              </div>
            ) : (
              <div className={styles.itemsGrid}>
                {items.map(item => {
                  const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
                  const isFav = favoriteStatusMap[item.id] || false;

                  return (
                    <div 
                      key={item.id} 
                      className={`${styles.itemCard} ${isFolder ? styles.folderCard : styles.fileCard}`}
                      onClick={() => isFolder ? handleFolderClick(item.id, item.name) : onSelectComic(item.id, item.name)}
                    >
                      <div className={styles.itemThumbnailArea}>
                        {isFolder ? (
                          <div className={styles.folderVisual}>
                            <Folder size={44} />
                          </div>
                        ) : thumbnails[item.id] ? (
                          <img src={thumbnails[item.id]} alt={item.name} className={styles.fileThumbnail} />
                        ) : (
                          <div className={styles.fileVisual}>
                            <FileArchive size={38} />
                          </div>
                        )}
                        
                        <button 
                          className={`${styles.favStarBtn} ${isFav ? styles.favActive : ''}`}
                          onClick={(e) => handleToggleFavorite(e, item, isFolder)}
                          aria-label="お気に入り登録"
                        >
                          <Star size={16} fill={isFav ? 'currentColor' : 'none'} />
                        </button>
                      </div>

                      <div className={styles.itemDetail}>
                        <span className={styles.itemName} title={item.name}>{item.name}</span>
                        {!isFolder && item.size && (
                          <span className={styles.itemSize}>{formatBytes(item.size)}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};
