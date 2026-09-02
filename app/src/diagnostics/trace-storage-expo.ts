import { Directory, File, Paths } from "expo-file-system";

import {
  readDiagnosticsTraces,
  writeDiagnosticsTrace,
  type DiagnosticsTrace,
  type DiagnosticsTraceDirectory,
  type DiagnosticsTraceFile,
} from "./trace-store";

function adaptFile(file: File): DiagnosticsTraceFile {
  return {
    get name() {
      return file.name;
    },
    get modificationTime() {
      return file.modificationTime;
    },
    write(content) {
      file.write(content);
    },
    text() {
      return file.text();
    },
    delete() {
      file.delete();
    },
  };
}

function openTraceDirectory(): DiagnosticsTraceDirectory {
  const directory = new Directory(Paths.document, "diagnostics", "traces");
  directory.create({ intermediates: true, idempotent: true });

  return {
    listFiles() {
      return directory
        .list()
        .filter((entry): entry is File => entry instanceof File)
        .map(adaptFile);
    },
    createFile(name, mimeType) {
      return adaptFile(directory.createFile(name, mimeType));
    },
  };
}

export async function writeDeviceDiagnosticsTrace(
  trace: DiagnosticsTrace,
): Promise<void> {
  await writeDiagnosticsTrace(openTraceDirectory(), trace);
}

export async function readDeviceDiagnosticsTraces(): Promise<DiagnosticsTrace[]> {
  return readDiagnosticsTraces(openTraceDirectory());
}
