import localforage from 'localforage';

export interface ReadingHistory {
  fileId: string;
  name: string;
  currentPage: number;
  totalPages: number;
  progress: number; // 百分率 (0 - 100)
  updatedAt: number;
}

export interface FavoriteItem {
  id: string;
  name: string;
  isFolder: boolean;
  parentId?: string;
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

export const getCachedFile = async (fileId: string): Promise<ArrayBuffer | null> => {
  return await fileCacheStore.getItem<ArrayBuffer>(fileId);
};

export const cacheFile = async (fileId: string, data: ArrayBuffer): Promise<void> => {
  try {
    await fileCacheStore.setItem(fileId, data);
  } catch (err) {
    // ストレージ容量超過時はキャッシュを諦める（動作には影響なし）
    console.warn('ファイルキャッシュの保存に失敗しました（容量不足の可能性）:', err);
  }
};

export const clearFileCache = async (): Promise<void> => {
  await fileCacheStore.clear();
};
