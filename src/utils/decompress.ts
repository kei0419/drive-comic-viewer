import { unzipSync } from 'fflate';
// unrar-js の型定義がない可能性があるため ts-ignore で回避
// @ts-ignore
import { Extractor } from 'unrar-js';

export interface ComicPage {
  name: string;
  url: string;
}

// ファイルパスからMIMEタイプを取得する
const getMimeType = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
};

// ファイル名の自然順ソート (1.jpg -> 2.jpg -> 10.jpg)
const naturalSort = (a: string, b: string) => {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

/**
 * ZIPアーカイブ(ArrayBuffer)を展開し、画像ファイルをソートしてBlob URLの一覧を返す
 */
export const decompressZip = async (arrayBuffer: ArrayBuffer): Promise<ComicPage[]> => {
  const uint8Array = new Uint8Array(arrayBuffer);
  // 同期的に展開 (fflateはブラウザ上で十分高速に動作します)
  const unzipped = unzipSync(uint8Array);
  
  const pages: ComicPage[] = [];
  const imageRegex = /\.(jpe?g|png|webp|gif|bmp)$/i;

  for (const [path, data] of Object.entries(unzipped)) {
    // ディレクトリや画像以外のファイルをスキップ
    if (path.endsWith('/') || !imageRegex.test(path)) continue;
    
    // パスからファイル名のみを切り出して判定するが、ソートにはフルパスを使う
    const blob = new Blob([data], { type: getMimeType(path) });
    const url = URL.createObjectURL(blob);
    pages.push({ name: path, url });
  }

  // ファイルパスで自然順ソート
  pages.sort((a, b) => naturalSort(a.name, b.name));
  return pages;
};

/**
 * RARアーカイブ(ArrayBuffer)を展開し、画像ファイルをソートしてBlob URLの一覧を返す
 */
export const decompressRar = async (arrayBuffer: ArrayBuffer): Promise<ComicPage[]> => {
  try {
    const extractor = new Extractor(new Uint8Array(arrayBuffer));
    const result = extractor.extractAll();
    
    // extractAll の返却値の確認。パッケージによっては result が直接ファイル配列の場合もある
    let files: any[] = [];
    if (result && result.state === 'SUCCESS' && result.files) {
      files = result.files;
    } else if (Array.isArray(result)) {
      files = result;
    } else if (result && Array.isArray(result.files)) {
      files = result.files;
    } else {
      throw new Error('RARの解凍形式がサポート対象外か、破損しています。');
    }

    const pages: ComicPage[] = [];
    const imageRegex = /\.(jpe?g|png|webp|gif|bmp)$/i;

    for (const file of files) {
      // ディレクトリチェック
      if (file.fileHeader?.flags?.directory || file.isDirectory) continue;
      
      const path = file.fileHeader?.name || file.name || '';
      const data = file.fileContent || file.content;
      
      if (!path || !data || !imageRegex.test(path)) continue;

      const blob = new Blob([data], { type: getMimeType(path) });
      const url = URL.createObjectURL(blob);
      pages.push({ name: path, url });
    }

    pages.sort((a, b) => naturalSort(a.name, b.name));
    return pages;
  } catch (error: any) {
    console.error('RAR extraction error:', error);
    throw new Error(`RAR展開エラー: ${error.message || error}`);
  }
};

/**
 * メモリリークを防ぐため、展開したBlob URLをすべて解放する
 */
export const revokeComicPages = (pages: ComicPage[]): void => {
  pages.forEach(page => {
    URL.revokeObjectURL(page.url);
  });
};
