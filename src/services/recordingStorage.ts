import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { once } from 'events';

const storageRoot = path.resolve(process.env.RECORDING_STORAGE_DIR || path.join(process.cwd(), '.private', 'recordings'));
const safeId = /^[a-f\d]{24}$/i;
const padded = (sequence: number) => String(sequence).padStart(10, '0');
function assertId(id: string): void { if (!safeId.test(id)) throw new Error('Invalid recording storage identifier'); }
function partsDirectory(recordingId: string): string { assertId(recordingId); return path.join(storageRoot, `${recordingId}.parts`); }
function finalPath(storageRef: string): string {
  if (!/^[a-f\d]{24}\.(webm|mp4|ogg)$/i.test(storageRef)) throw new Error('Invalid recording storage reference');
  return path.join(storageRoot, storageRef);
}

export interface RecordingStorageAdapter {
  writeChunk(recordingId: string, sequence: number, bytes: Buffer): Promise<void>;
  removeChunk(recordingId: string, sequence: number): Promise<void>;
  assemble(recordingId: string, mimeType: string, sequences: number[]): Promise<{ storageRef: string; fileSize: number; format: string }>;
  open(storageRef: string, start?: number, end?: number): ReturnType<typeof createReadStream>;
  getSize(storageRef: string): Promise<number>;
  remove(storageRef?: string, recordingId?: string): Promise<void>;
}

class PrivateFilesystemRecordingStorage implements RecordingStorageAdapter {
  async writeChunk(recordingId: string, sequence: number, bytes: Buffer): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid recording sequence');
    await mkdir(partsDirectory(recordingId), { recursive: true, mode: 0o700 });
    await writeFile(path.join(partsDirectory(recordingId), `${padded(sequence)}.part`), bytes, { flag: 'wx', mode: 0o600 });
  }
  async removeChunk(recordingId: string, sequence: number): Promise<void> { await rm(path.join(partsDirectory(recordingId), `${padded(sequence)}.part`), { force: true }); }

  async assemble(recordingId: string, mimeType: string, sequences: number[]): Promise<{ storageRef: string; fileSize: number; format: string }> {
    assertId(recordingId);
    const extension = mimeType.startsWith('video/mp4') ? 'mp4' : mimeType.startsWith('video/ogg') ? 'ogg' : 'webm';
    const storageRef = `${recordingId}.${extension}`;
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const output = createWriteStream(finalPath(storageRef), { flags: 'w', mode: 0o600 });
    try {
      for (const sequence of sequences) {
        const input = createReadStream(path.join(partsDirectory(recordingId), `${padded(sequence)}.part`));
        for await (const data of input) {
          if (!output.write(data)) await once(output, 'drain');
        }
      }
      output.end();
      await once(output, 'finish');
    } catch (error) {
      output.destroy();
      await rm(finalPath(storageRef), { force: true }).catch(() => undefined);
      throw error;
    }
    const fileSize = (await stat(finalPath(storageRef))).size;
    return { storageRef, fileSize, format: `${extension}/${mimeType.split(';')[1]?.trim() || 'default'}` };
  }

  open(storageRef: string, start?: number, end?: number) { return createReadStream(finalPath(storageRef), start === undefined ? undefined : { start, end }); }
  async getSize(storageRef: string) { return (await stat(finalPath(storageRef))).size; }
  async remove(storageRef?: string, recordingId?: string) {
    if (storageRef) await rm(finalPath(storageRef), { force: true });
    if (recordingId) await rm(partsDirectory(recordingId), { recursive: true, force: true });
  }
}

let storage: RecordingStorageAdapter = new PrivateFilesystemRecordingStorage();
export function getRecordingStorage(): RecordingStorageAdapter { return storage; }
export function setRecordingStorage(adapter: RecordingStorageAdapter): void { storage = adapter; }
