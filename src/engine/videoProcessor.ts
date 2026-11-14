import type { VideoProcessResult, VideoProgress, VideoSettings } from './videoEngine';

let nextRequestId = 1;

/**
 * Runs the WebCodecs pipeline in a module worker so decoding, correlation,
 * inpainting, and re-encoding never block the UI thread. Falls back to the
 * main-thread implementation when workers are unavailable.
 */
export async function processVideoInWorker(
  buffer: ArrayBuffer,
  settings: Partial<VideoSettings>,
  onProgress?: (progress: VideoProgress) => void,
  signal?: AbortSignal
): Promise<VideoProcessResult> {
  if (signal?.aborted) {
    throw new DOMException('Video processing was cancelled.', 'AbortError');
  }

  if (typeof Worker === 'undefined') {
    const { processVideo } = await import('./videoEngine');
    return processVideo(buffer, settings, onProgress, signal);
  }

  const id = nextRequestId++;
  const assetBase = new URL(import.meta.env.BASE_URL || './', window.location.href).href;

  let worker: Worker;
  try {
    worker = new Worker(new URL('./videoWorker.ts', import.meta.url), {
      type: 'module',
      name: 'inverta-video-engine',
    });
  } catch {
    const { processVideo } = await import('./videoEngine');
    return processVideo(buffer, settings, onProgress, signal);
  }

  return new Promise<VideoProcessResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
      return true;
    };

    const handleAbort = () => {
      if (!cleanup()) return;
      reject(new DOMException('Video processing was cancelled.', 'AbortError'));
    };

    const fail = (error: Error) => {
      if (!cleanup()) return;
      reject(error);
    };

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: 'progress'; id: number; progress: VideoProgress }
        | { type: 'done'; id: number; result: VideoProcessResult }
        | { type: 'error'; id: number; error: string; aborted?: boolean; code?: string };

      if (!message || message.id !== id) return;

      if (message.type === 'progress') {
        onProgress?.(message.progress);
        return;
      }

      if (message.type === 'done') {
        if (!cleanup()) return;
        resolve(message.result);
        return;
      }

      if (message.code === 'webcodecs-unavailable') {
        // The worker cannot run WebCodecs in this browser. Signal the caller so
        // it can retry on the main thread with a freshly read file buffer.
        const unavailable = new Error(
          message.error || 'WebCodecs is unavailable inside this browser worker.'
        );
        unavailable.name = 'VideoWorkerUnavailableError';
        fail(unavailable);
        return;
      }

      fail(
        message.aborted
          ? new DOMException('Video processing was cancelled.', 'AbortError')
          : new Error(message.error || 'Video processing failed')
      );
    };

    worker.onerror = (event) => {
      fail(new Error(event.message || 'The video worker crashed unexpectedly.'));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    try {
      worker.postMessage(
        {
          type: 'process',
          id,
          buffer,
          settings,
          assetBase,
        },
        [buffer]
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Could not start the video worker.'));
    }
  });
}
