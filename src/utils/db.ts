import localforage from 'localforage';

export interface ReadingHistory {
  fileId: string;
  name: string;
  currentPage: number;
  totalPages: number;
  progress: number; // 百分率 (0 - 100)
  updatedAt: number;
}

export interface FavoritePathNode {
  id: string;
  name: string;
}

export interface FavoriteItem {
  id: string;
  name: string;
  isFolder: boolean;
  parentId?: string;
  path?: FavoritePathNode[];
  addedAt: number;
}

export interface AppSettings {
  clientId: string;
  theme: 'light' | 'dark';
}

// localforage インスタンスの生成
export const historyStore = localforage.createInstance({
  name: 'CloudComicReader',
  storeName: 'history'
});

export const favoritesStore = localforage.createInstance({
  name: 'CloudComicReader',
  storeName: 'favorites'
});

export const settingsStore = localforage.createInstance({
  name: 'CloudComicReader',
  storeName: 'settings'
});

export const thumbnailStore = localforage.createInstance({
  name: 'CloudComicReader',
  storeName: 'thumbnails'
});

// 読書履歴のヘルパー関数
export const getHistory = async (): Promise<ReadingHistory[]> => {
  const keys = await historyStore.keys();
  const historyList: ReadingHistory[] = [];
  for (const key of keys) {
    const item = await historyStore.getItem<ReadingHistory>(key);
    if (item) historyList.push(item);
  }
  // 更新日時の新しい順にソート
  return historyList.sort((a, b) => b.updatedAt - a.updatedAt);
};

export const saveHistory = async (history: ReadingHistory): Promise<void> => {
  await historyStore.setItem(history.fileId, history);
};

export const deleteHistory = async (fileId: string): Promise<void> => {
  await historyStore.removeItem(fileId);
};

// お気に入りのヘルパー関数
export const getFavorites = async (): Promise<FavoriteItem[]> => {
  const keys = await favoritesStore.keys();
  const favoritesList: FavoriteItem[] = [];
  for (const key of keys) {
    const item = await favoritesStore.getItem<FavoriteItem>(key);
    if (item) favoritesList.push(item);
  }
  return favoritesList.sort((a, b) => b.addedAt - a.addedAt);
};

export const addFavorite = async (item: FavoriteItem): Promise<void> => {
  await favoritesStore.setItem(item.id, item);
};

export const removeFavorite = async (id: string): Promise<void> => {
  await favoritesStore.removeItem(id);
};

export const isFavorite = async (id: string): Promise<boolean> => {
  const item = await favoritesStore.getItem(id);
  return item !== null;
};

// 設定のヘルパー関数
export const getSettings = async (): Promise<AppSettings> => {
  const settings = await settingsStore.getItem<AppSettings>('app_settings');
  return settings || { clientId: '', theme: 'dark' };
};

export const saveSettings = async (settings: AppSettings): Promise<void> => {
  await settingsStore.setItem('app_settings', settings);
};

// サムネイルのヘルパー関数
export const getThumbnail = async (fileId: string): Promise<string | null> => {
  return await thumbnailStore.getItem<string>(fileId);
};

export const saveThumbnail = async (fileId: string, base64Data: string): Promise<void> => {
  await thumbnailStore.setItem(fileId, base64Data);
};

// ファイルキャッシュ（ダウンロード済みアーカイブの保存用）
export const fileCacheStore = localforage.createInstance({
  name: 'CloudComicReader',
  storeName: 'fileCache'
});

export const fileCacheMetaStore = localforage.createInstance({
  name: 'CloudComicReader',
  storeName: 'fileCacheMeta'
});

export interface FileCacheMeta {
  fileId: string;
  byteLength: number;
  lastAccessedAt: number;
}

const MAX_CACHED_FILES = 10;

const syncCacheMetadata = async (): Promise<FileCacheMeta[]> => {
  const [cacheKeys, metaKeys] = await Promise.all([
    fileCacheStore.keys(),
    fileCacheMetaStore.keys()
  ]);

  const cacheKeySet = new Set(cacheKeys);
  const metaMap = new Map<string, FileCacheMeta>();

  for (const key of metaKeys) {
    if (!cacheKeySet.has(key)) {
      await fileCacheMetaStore.removeItem(key);
      continue;
    }
    const meta = await fileCacheMetaStore.getItem<FileCacheMeta>(key);
    if (meta) {
      metaMap.set(key, meta);
    }
  }

  for (const key of cacheKeys) {
    if (!metaMap.has(key)) {
      const data = await fileCacheStore.getItem<ArrayBuffer>(key);
      if (data) {
        const meta: FileCacheMeta = {
          fileId: key,
          byteLength: data.byteLength,
          lastAccessedAt: Date.now()
        };
        await fileCacheMetaStore.setItem(key, meta);
        metaMap.set(key, meta);
      }
    }
  }

  return Array.from(metaMap.values()).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
};

const evictCacheEntry = async (fileId: string): Promise<void> => {
  await Promise.all([
    fileCacheStore.removeItem(fileId),
    fileCacheMetaStore.removeItem(fileId)
  ]);
};

export const getCachedFile = async (fileId: string): Promise<ArrayBuffer | null> => {
  const data = await fileCacheStore.getItem<ArrayBuffer>(fileId);
  if (data) {
    await fileCacheMetaStore.setItem<FileCacheMeta>(fileId, {
      fileId,
      byteLength: data.byteLength,
      lastAccessedAt: Date.now()
    });
  }
  return data;
};

export const cacheFile = async (fileId: string, data: ArrayBuffer): Promise<void> => {
  try {
    const metas = (await syncCacheMetadata()).filter((meta) => meta.fileId !== fileId);

    while (metas.length >= MAX_CACHED_FILES) {
      const oldest = metas.shift();
      if (!oldest) break;
      await evictCacheEntry(oldest.fileId);
    }

    while (true) {
      try {
        await fileCacheStore.setItem(fileId, data);
        await fileCacheMetaStore.setItem<FileCacheMeta>(fileId, {
          fileId,
          byteLength: data.byteLength,
          lastAccessedAt: Date.now()
        });
        return;
      } catch (err) {
        const oldest = metas.shift();
        if (!oldest) {
          throw err;
        }
        await evictCacheEntry(oldest.fileId);
      }
    }
  } catch (err) {
    // ストレージ容量超過時はキャッシュを諦める（動作には影響なし）
    console.warn('ファイルキャッシュの保存に失敗しました（容量不足の可能性）:', err);
  }
};

export const getFileCacheStats = async (): Promise<{ count: number; totalBytes: number }> => {
  const metas = await syncCacheMetadata();
  const totalBytes = metas.reduce((sum, meta) => sum + meta.byteLength, 0);
  return {
    count: metas.length,
    totalBytes
  };
};

export const clearFileCache = async (): Promise<void> => {
  await Promise.all([
    fileCacheStore.clear(),
    fileCacheMetaStore.clear()
  ]);
};
