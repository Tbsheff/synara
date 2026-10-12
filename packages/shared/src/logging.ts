import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROTATION_RETRY_MS = 30_000;

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
  readonly mode?: number;
  readonly onRotationError?: (error: unknown) => void;
  readonly rotationRetryMs?: number;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly mode: number | undefined;
  private readonly onRotationError: ((error: unknown) => void) | undefined;
  private readonly rotationRetryMs: number;
  private currentSize = 0;
  private rotationRetryAt = 0;
  private rotationFailureReported = false;
  private pendingRotationError: { readonly error: unknown } | undefined;

  constructor(options: RotatingFileSinkOptions, deferInitialization = false) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
    this.mode = options.mode;
    this.onRotationError = options.onRotationError;
    this.rotationRetryMs = Math.max(0, options.rotationRetryMs ?? DEFAULT_ROTATION_RETRY_MS);

    if (deferInitialization) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  static async createAsync(options: RotatingFileSinkOptions): Promise<RotatingFileSink> {
    const sink = new RotatingFileSink(options, true);
    await fs.promises.mkdir(path.dirname(options.filePath), { recursive: true });
    await sink.pruneOverflowBackupsAsync();
    sink.currentSize = await sink.readCurrentSizeAsync();
    return sink;
  }

  write(chunk: string | Buffer): void {
    this.appendChunks([chunk]);
  }

  writeMany(chunks: ReadonlyArray<string | Buffer>): number {
    this.currentSize = this.readCurrentSize();
    return this.appendChunks(chunks);
  }

  private appendChunks(chunks: ReadonlyArray<string | Buffer>): number {
    let written = 0;
    try {
      let group: Buffer[] = [];
      let groupBytes = 0;
      const appendGroup = () => {
        if (group.length === 0) return;
        const data = group.length === 1 ? group[0]! : Buffer.concat(group, groupBytes);
        group = [];
        groupBytes = 0;
        this.append(data);
        written += data.length;
      };

      for (const chunk of chunks) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (buffer.length === 0) continue;
        const projected = this.currentSize + groupBytes;
        if (projected > 0 && projected + buffer.length > this.maxBytes) {
          appendGroup();
          if (!this.makeRoom()) {
            throw new Error(`Log file ${this.filePath} is full and could not be rotated`);
          }
        }
        group.push(buffer);
        groupBytes += buffer.length;
      }
      appendGroup();

      if (this.currentSize > this.maxBytes) {
        this.makeRoom();
      }
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        this.reportPendingRotationError();
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
    this.reportPendingRotationError();
    return written;
  }

  private append(data: Buffer): void {
    if (this.mode === undefined) {
      fs.appendFileSync(this.filePath, data);
    } else {
      fs.appendFileSync(this.filePath, data, { mode: this.mode });
    }
    this.currentSize += data.length;
  }

  private makeRoom(): boolean {
    const now = Date.now();
    if (now >= this.rotationRetryAt) {
      const error = this.rotate();
      if (error === undefined) {
        this.rotationRetryAt = 0;
        this.rotationFailureReported = false;
        return true;
      }
      this.rotationRetryAt = now + this.rotationRetryMs;
      if (!this.rotationFailureReported) {
        this.rotationFailureReported = true;
        this.pendingRotationError = { error };
      }
    }

    try {
      fs.truncateSync(this.filePath, 0);
      this.currentSize = 0;
      return true;
    } catch {
      this.currentSize = this.readCurrentSize();
      return this.currentSize === 0;
    }
  }

  private rotate(): unknown {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
      return undefined;
    } catch (error) {
      this.currentSize = this.readCurrentSize();
      return error;
    }
  }

  async writeManyAsync(chunks: ReadonlyArray<string | Buffer>): Promise<number> {
    this.currentSize = await this.readCurrentSizeAsync();
    return this.appendChunksAsync(chunks);
  }

  private async appendChunksAsync(chunks: ReadonlyArray<string | Buffer>): Promise<number> {
    let written = 0;
    try {
      let group: Buffer[] = [];
      let groupBytes = 0;
      const appendGroup = async () => {
        if (group.length === 0) return;
        const data = group.length === 1 ? group[0]! : Buffer.concat(group, groupBytes);
        group = [];
        groupBytes = 0;
        await this.appendAsync(data);
        written += data.length;
      };

      for (const chunk of chunks) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (buffer.length === 0) continue;
        const projected = this.currentSize + groupBytes;
        if (projected > 0 && projected + buffer.length > this.maxBytes) {
          await appendGroup();
          if (!(await this.makeRoomAsync())) {
            throw new Error(`Log file ${this.filePath} is full and could not be rotated`);
          }
        }
        group.push(buffer);
        groupBytes += buffer.length;
      }
      await appendGroup();

      if (this.currentSize > this.maxBytes) {
        await this.makeRoomAsync();
      }
    } catch {
      this.currentSize = await this.readCurrentSizeAsync();
      if (this.throwOnError) {
        this.reportPendingRotationError();
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
    this.reportPendingRotationError();
    return written;
  }

  private async appendAsync(data: Buffer): Promise<void> {
    if (this.mode === undefined) {
      await fs.promises.appendFile(this.filePath, data);
    } else {
      await fs.promises.appendFile(this.filePath, data, { mode: this.mode });
    }
    this.currentSize += data.length;
  }

  private async makeRoomAsync(): Promise<boolean> {
    const now = Date.now();
    if (now >= this.rotationRetryAt) {
      const error = await this.rotateAsync();
      if (error === undefined) {
        this.rotationRetryAt = 0;
        this.rotationFailureReported = false;
        return true;
      }
      this.rotationRetryAt = now + this.rotationRetryMs;
      if (!this.rotationFailureReported) {
        this.rotationFailureReported = true;
        this.pendingRotationError = { error };
      }
    }

    try {
      await fs.promises.truncate(this.filePath, 0);
      this.currentSize = 0;
      return true;
    } catch {
      this.currentSize = await this.readCurrentSizeAsync();
      return this.currentSize === 0;
    }
  }

  private async rotateAsync(): Promise<unknown> {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      await fs.promises.rm(oldest, { force: true });

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        try {
          await fs.promises.rename(source, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      try {
        await fs.promises.rename(this.filePath, this.withSuffix(1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      this.currentSize = 0;
      return undefined;
    } catch (error) {
      this.currentSize = await this.readCurrentSizeAsync();
      return error;
    }
  }

  private reportPendingRotationError(): void {
    const pending = this.pendingRotationError;
    if (pending === undefined) return;
    this.pendingRotationError = undefined;
    try {
      if (this.onRotationError) {
        this.onRotationError(pending.error);
      } else {
        console.warn(
          `[RotatingFileSink] Could not rotate ${this.filePath}; truncating it to stay within ${this.maxBytes} bytes until rotation succeeds.`,
          pending.error,
        );
      }
    } catch {}
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private async pruneOverflowBackupsAsync(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of await fs.promises.readdir(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        await fs.promises.rm(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) throw new Error(`Failed to prune log backups for ${this.filePath}`);
    }
  }

  private async readCurrentSizeAsync(): Promise<number> {
    try {
      return (await fs.promises.stat(this.filePath)).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
