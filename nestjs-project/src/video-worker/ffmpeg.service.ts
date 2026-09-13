import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

const JSON_BUFFER_LIMIT = 10 * 1024 * 1024;

@Injectable()
export class FfmpegService {
  /**
   * Extrai duração, resolução e codec via `ffprobe` a partir de um arquivo
   * ou URL (FFmpeg lê HTTP nativamente — o worker usa a presigned URL do MinIO).
   */
  async probe(source: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        source,
      ],
      { maxBuffer: JSON_BUFFER_LIMIT },
    );

    const data = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = data.streams?.find((s) => s.codec_type === 'video');

    const duration = Math.round(
      parseFloat(videoStream?.duration ?? data.format?.duration ?? '0'),
    );

    return {
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      codec: videoStream?.codec_name ?? '',
    };
  }

  /**
   * Extrai um frame (thumbnail) do vídeo via `ffmpeg`, retornando o buffer JPG.
   * `-f image2pipe -` escreve a imagem na stdout, que é capturada como Buffer.
   */
  async extractThumbnail(
    source: string,
    timestampSeconds = 4,
  ): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-ss',
        String(timestampSeconds),
        '-i',
        source,
        '-vframes',
        '1',
        '-q:v',
        '2',
        '-f',
        'image2pipe',
        '-',
      ],
      { maxBuffer: JSON_BUFFER_LIMIT, encoding: 'buffer' },
    );

    return Buffer.from(stdout);
  }
}
