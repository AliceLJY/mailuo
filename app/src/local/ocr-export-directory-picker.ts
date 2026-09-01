// Keep this file stem distinct from ocr-export.ts to avoid Metro self-resolution.
import { Directory, File } from "expo-file-system";

import {
  writeOcrExportToDirectory,
  type OcrExportBundle,
} from "./ocr-export";

export type PickedOcrExport = {
  fileName: string;
  fileUri: string;
};

export function readSourceMd5(uri: string): string | null {
  try {
    return new File(uri).md5;
  } catch {
    return null;
  }
}

export async function exportOcrBundleWithDirectoryPicker(
  createBundle: () => OcrExportBundle,
): Promise<PickedOcrExport> {
  const directory = await Directory.pickDirectoryAsync();

  // SAF directories return content:// URIs on Android. The shared writer uses
  // createFile on the picked Directory instead of constructing a path by hand.
  // Building after the picker returns makes exportedAt the actual export time,
  // not the earlier screenshot-processing timestamp.
  return writeOcrExportToDirectory(directory, createBundle());
}
