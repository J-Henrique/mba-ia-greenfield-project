import { FfmpegService } from './ffmpeg.service';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';

const execFileAsync = promisify(execFile);

describe('FfmpegService (integration — real ffmpeg binary)', () => {
  let ffmpegService: FfmpegService;
  let testVideoPath: string;

  beforeAll(async () => {
    ffmpegService = new FfmpegService();

    // Gera um vídeo real de 6s (640x360, h264) via ffmpeg para servir de fonte
    testVideoPath = `/tmp/test-video-${Date.now()}.mp4`;
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=6:size=640x360:rate=15',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-f',
      'mp4',
      testVideoPath,
    ]);
  });

  afterAll(async () => {
    await fs.rm(testVideoPath, { force: true });
  });

  it('should extract metadata with ffprobe', async () => {
    const metadata = await ffmpegService.probe(testVideoPath);

    expect(metadata.durationSeconds).toBeGreaterThan(0);
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(360);
    expect(metadata.codec).toBe('h264');
  });

  it('should extract a thumbnail frame as a JPEG buffer', async () => {
    const buffer = await ffmpegService.extractThumbnail(testVideoPath, 2);

    expect(buffer.length).toBeGreaterThan(0);
    // Magic bytes JPEG: 0xFF 0xD8 0xFF
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
    expect(buffer[2]).toBe(0xff);
  });
});
