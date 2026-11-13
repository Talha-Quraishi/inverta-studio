declare module 'mp4box' {
  export interface Mp4VideoInfo {
    width: number;
    height: number;
  }

  export interface Mp4AudioInfo {
    sample_rate: number;
    channel_count: number;
  }

  export interface Mp4Track {
    id: number;
    codec: string;
    timescale: number;
    video?: Mp4VideoInfo;
    audio?: Mp4AudioInfo;
  }

  export interface Mp4Info {
    videoTracks?: Mp4Track[];
    audioTracks?: Mp4Track[];
  }

  export interface Mp4Sample {
    data: Uint8Array;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
  }

  export interface Mp4Box {
    write(stream: unknown): void;
  }

  export interface Mp4TrackBox {
    mdia?: {
      minf?: {
        stbl?: {
          stsd?: {
            entries?: Array<Record<string, Mp4Box | undefined>>;
          };
        };
      };
    };
  }

  export type MP4ArrayBuffer = ArrayBuffer & { fileStart: number };

  export interface MP4File {
    onReady?: (info: Mp4Info) => void;
    onError?: (error: unknown) => void;
    onSamples?: (id: number, user: string, samples: Mp4Sample[]) => void;
    setExtractionOptions(id: number, user: string, options: { nbSamples?: number }): void;
    appendBuffer(data: MP4ArrayBuffer): number;
    flush(): void;
    start(): void;
    getTrackById(id: number): Mp4TrackBox | undefined;
  }

  export function createFile(): MP4File;

  export class DataStream {
    static BIG_ENDIAN: boolean;
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    buffer: ArrayBuffer;
  }
}
