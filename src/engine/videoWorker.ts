/// <reference lib="webworker" />

import { processVideo, setVideoAssetBase } from './videoEngine';
import type { VideoProgress, VideoSettings } from './videoEngine';

interface ProcessRequest {
  type: 'process';
  id: number;
  buffer: ArrayBuffer;
  settings: Partial<VideoSettings>;
  assetBase: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ProcessRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

workerScope.onmessage = async (event: MessageEvent<ProcessRequest>) => {
  const data = event.data;
  if (!data || data.type !== 'process') return;

  // Some browsers expose WebCodecs on the window but not inside workers.
  // Report that state explicitly so the main thread can retry there.
  const hasWebCodecs =
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined';
  if (!hasWebCodecs) {
    workerScope.postMessage({
      type: 'error',
      id: data.id,
      error: 'WebCodecs is unavailable inside this browser worker.',
      code: 'webcodecs-unavailable',
    });
    return;
  }

  setVideoAssetBase(data.assetBase);

  try {
    const result = await processVideo(data.buffer, data.settings, (progress: VideoProgress) => {
      workerScope.postMessage({ type: 'progress', id: data.id, progress });
    });
    workerScope.postMessage({ type: 'done', id: data.id, result });
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      id: data.id,
      error: error instanceof Error ? error.message : 'Video processing failed',
      aborted: error instanceof Error && error.name === 'AbortError',
    });
  }
};
