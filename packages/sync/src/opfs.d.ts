// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// OPFS sync access handles, which only dedicated workers have: TypeScript declares them in its
// WebWorker library, which can't be combined with the DOM one the package builds against. A
// script, not a module, so these merge into the globals.

interface FileSystemReadWriteOptions {
  at?: number;
}

interface FileSystemSyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number;
  write(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
