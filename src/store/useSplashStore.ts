import { create } from 'zustand';
import type { SplashData } from '../lib/types';
import { parseSplashImg, extractImages } from '../lib/splash-parser';
import { cleanupSplashData } from '../lib/splash-packer';
import { imageFileToBmp } from '../lib/bmp';
import i18n from '../i18n';
import JSZip from 'jszip';

interface SplashState {
  splashData: SplashData | null;
  isLoading: boolean;
  error: string | null;
  progress: number;
  replacingIndex: number | null;
  replaceProgress: number;
  isPackingImages: boolean;
  packImagesProgress: number;

  loadSplash: (file: File) => Promise<void>;
  replaceImage: (index: number, file: File, resolutionMode: 'original' | 'follow' | 'custom' | 'direct', customWidth?: number, customHeight?: number) => Promise<void>;
  packAndDownload: () => Promise<void>;
  packImagesAndDownload: () => Promise<void>;
  reset: () => void;
}

export const useSplashStore = create<SplashState>((set, get) => ({
  splashData: null,
  isLoading: false,
  error: null,
  progress: 0,
  replacingIndex: null,
  replaceProgress: 0,
  isPackingImages: false,
  packImagesProgress: 0,
  
  loadSplash: async (file: File) => {
    set({ isLoading: true, error: null, progress: 0 });
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      console.log('=== 原始文件信息 ===');
      console.log('原始 splash.img 文件大小:', arrayBuffer.byteLength);
      
      const splashData = parseSplashImg(arrayBuffer);
      
      set({ progress: 50 });
      
      await extractImages(splashData);
      
      set({
        splashData,
        isLoading: false,
        progress: 100,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18n.t('store.loadFailed'),
        isLoading: false,
        progress: 0,
      });
    }
  },
  
  replaceImage: async (index: number, file: File, resolutionMode: 'original' | 'follow' | 'custom' | 'direct' = 'direct', customWidth?: number, customHeight?: number) => {
    const { splashData } = get();

    if (!splashData) {
      throw new Error(i18n.t('store.noSplashData'));
    }

    const oldImage = splashData.images[index];
    const refWidth = oldImage.originalWidth;
    const refHeight = oldImage.originalHeight;
    const maxAllowedWidth = splashData.header.width;
    const maxAllowedHeight = splashData.header.height;

    // 直接上传模式：只读取文件并更新，不转换不压缩
    if (resolutionMode === 'direct') {
      set({ replacingIndex: index, replaceProgress: 0 });
      try {
        // 让 UI 有机会渲染 loading 状态
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const arrayBuffer = await file.arrayBuffer();
        const bmpData = new Uint8Array(arrayBuffer);

        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(i18n.t('store.imageLoadFailed'))); };
          img.src = url;
        });

        const newBlob = new Blob([arrayBuffer], { type: file.type });
        const newPreviewUrl = URL.createObjectURL(newBlob);

        const newImages = [...splashData.images];
        newImages[index] = {
          ...oldImage,
          width: img.width,
          height: img.height,
          bmpData,
          blob: newBlob,
          previewUrl: newPreviewUrl,
        };

        set({
          splashData: {
            ...splashData,
            images: newImages,
          },
          replacingIndex: null,
          replaceProgress: 100,
        });

        setTimeout(() => {
          set({ replaceProgress: 0 });
        }, 500);
        return;
      } catch (err) {
        set({ replacingIndex: null, replaceProgress: 0 });
        throw err;
      }
    }

    set({ replacingIndex: index, replaceProgress: 0 });

    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      set({ replaceProgress: 20 });

      // 确定目标分辨率
      let targetWidth = maxAllowedWidth;
      let targetHeight = maxAllowedHeight;
      let fitMode: 'cover' | 'contain' | 'stretch' = 'cover';

      if (resolutionMode === 'follow') {
        targetWidth = refWidth;
        targetHeight = refHeight;
        fitMode = 'cover';

      } else if (resolutionMode === 'original') {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(i18n.t('store.imageLoadFailed'))); };
          img.src = url;
        });
        targetWidth = Math.min(img.width, maxAllowedWidth);
        targetHeight = Math.min(img.height, maxAllowedHeight);
        fitMode = 'stretch';

      } else if (resolutionMode === 'custom' && customWidth && customHeight) {
        targetWidth = customWidth;
        targetHeight = customHeight;
        fitMode = 'cover';
      }

      // 阶段 1: 转换 BMP (20%-50%)
      const bmpData = await imageFileToBmp(
        file,
        targetWidth,
        targetHeight,
        false,
        fitMode,
        (progress) => {
          const finalProgress = 20 + progress * 0.3;
          set({ replaceProgress: Math.min(Math.round(finalProgress), 50) });
        }
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      // 阶段 2: 压缩 (60%-90%)
      const { compressGzip } = await import('../lib/gzip');

      set({ replaceProgress: 60 });
      await new Promise(resolve => setTimeout(resolve, 10));

      await compressGzip(bmpData, (progress) => {
        const finalProgress = 60 + progress * 0.3;
        set({ replaceProgress: Math.min(Math.round(finalProgress), 90) });
      });

      set({ replaceProgress: 90 });

      if (oldImage.previewUrl) {
        URL.revokeObjectURL(oldImage.previewUrl);
      }

      const newBlob = new Blob([bmpData.buffer as ArrayBuffer], { type: 'image/bmp' });
      const newPreviewUrl = URL.createObjectURL(newBlob);

      const newImages = [...splashData.images];
      newImages[index] = {
        ...oldImage,
        width: targetWidth,
        height: targetHeight,
        bmpData,
        blob: newBlob,
        previewUrl: newPreviewUrl,
      };

      set({
        splashData: {
          ...splashData,
          images: newImages,
        },
        replacingIndex: null,
        replaceProgress: 100,
      });

      // 重置进度
      setTimeout(() => {
        set({ replaceProgress: 0 });
      }, 500);
    } catch (err) {
      set({ replacingIndex: null, replaceProgress: 0 });
      throw err;
    }
  },
  
  packAndDownload: async () => {
    const { splashData } = get();

    if (!splashData) {
      throw new Error(i18n.t('store.noSplashData'));
    }
    
    console.log('=== 打包前调试信息 ===');
    console.log('图片数量:', splashData.images.length);
    console.log('Header imgnumber:', splashData.header.imgnumber);
    console.log('图片总 BMP 大小:', splashData.images.reduce((sum, img) => sum + img.bmpData.length, 0));
    console.log('原始文件大小:', splashData.originalBuffer.byteLength);
    for (const img of splashData.images) {
      console.log(`图片 ${img.index} [${img.name}]: BMP 大小 = ${img.bmpData.length}`);
    }
    
    set({ isLoading: true, progress: 0 });
    
    try {
      const { packSplashImgWithProgress } = await import('../lib/splash-packer');
      const packed = await packSplashImgWithProgress(splashData, splashData.originalBuffer.byteLength, (progress: number) => {
        set({ progress });
      });
      
      console.log('=== 打包后调试信息 ===');
      console.log('打包后文件大小:', packed.length);
      
      const { downloadFile } = await import('../lib/utils');
      downloadFile(packed, 'new-splash.img');
      
      set({ isLoading: false, progress: 100 });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18n.t('store.packFailed'),
        isLoading: false,
        progress: 0,
      });
    }
  },
  
  packImagesAndDownload: async () => {
    const { splashData } = get();

    if (!splashData) {
      throw new Error(i18n.t('store.noSplashData'));
    }
    
    set({ isPackingImages: true, packImagesProgress: 0 });
    
    try {
      const zip = new JSZip();
      const totalImages = splashData.images.length;
      
      splashData.images.forEach((image, index) => {
        const fileName = image.name.endsWith('.bmp') ? image.name : `${image.name}.bmp`;
        zip.file(fileName, image.bmpData);
        const progress = Math.round(((index + 1) / totalImages) * 100);
        set({ packImagesProgress: progress });
      });
      
      const content = await zip.generateAsync({ type: 'blob' });
      
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'splash-images.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      set({ isPackingImages: false, packImagesProgress: 100 });
      
      setTimeout(() => {
        set({ packImagesProgress: 0 });
      }, 500);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18n.t('store.packFailed'),
        isPackingImages: false,
        packImagesProgress: 0,
      });
    }
  },
  
  reset: () => {
    const { splashData } = get();
    if (splashData) {
      cleanupSplashData(splashData);
    }
    set({
      splashData: null,
      isLoading: false,
      error: null,
      progress: 0,
    });
  },
}));
