import {
  ArrayMinSize,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PartEntry {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  etag: string;
}

export class CompleteUploadDto {
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => PartEntry)
  parts: PartEntry[];
}
