import { Type } from 'class-transformer';
import { IsInt, IsMimeType, IsNotEmpty, IsString } from 'class-validator';

/** Tamanho máximo de upload: 10GB em bytes. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export class InitiateUploadDto {
  /** Nome original do arquivo enviado (ex: `minha-aula.mp4`). */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** Tipo MIME do arquivo (ex: `video/mp4`). */
  @IsMimeType()
  mimeType: string;

  /** Tamanho do arquivo em bytes. */
  @Type(() => Number)
  @IsInt()
  fileSize: number;
}
