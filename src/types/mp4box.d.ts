declare module 'mp4box' {
  export interface MP4File {
    onReady?: (info: any) => void;
    onError?: (error: any) => void;
    onSamples?: (id: number, user: any, samples: any[]) => void;
    setExtractionOptions(id: number, user: any, options: any): void;
    appendBuffer(data: ArrayBuffer): number;
    flush(): void;
    start(): void;
    getTrackById(id: number): any;
  }

  export function createFile(): MP4File;
  export const DataStream: any;
}
