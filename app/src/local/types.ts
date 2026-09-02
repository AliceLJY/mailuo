import type { ExecuteStore } from "../../../shared/core/agent/execute.ts";
import type { InsightGenerationDb } from "../../../shared/core/agent/insight.ts";
import type { ActionCard } from "../../../shared/types.ts";
import type {
  ActionCardDisambiguation,
  ActionCardRecord,
  ContactDetail,
  ContactListItem,
  ContactRecord,
  InsightRecord,
  MeetingRecord,
  ObservationRecord,
  ScreenshotDetail,
  ScreenshotRecord,
  UploadImageAsset,
} from "../types";

export type DiagnosticsSnapshot = {
  readonly screenshots: readonly ScreenshotRecord[];
  readonly action_cards: readonly ActionCardRecord[];
  readonly contacts: readonly ContactRecord[];
  readonly observations: readonly ObservationRecord[];
  readonly meetings: readonly MeetingRecord[];
  readonly insights: readonly InsightRecord[];
};

export interface DiagnosticsDataSource {
  readDiagnosticsSnapshot(): DiagnosticsSnapshot;
}

export interface LocalStore extends ExecuteStore, InsightGenerationDb {
  getStoredActionCardById(cardId: number): ActionCardRecord | null;
  createScreenshot(input: {
    imagePath: string;
    userNote?: string | null;
    uploadedAt?: string;
  }): ScreenshotRecord;
  saveScreenshotAnalysis(input: {
    screenshotId: number;
    rawExtraction: unknown;
    cards: ActionCard[];
    pendingCardUpdates?: Array<{
      cardId: number;
      payload: ActionCard["payload"];
      sourceQuote: string;
    }>;
    createdAt?: string;
  }): ActionCardRecord[];
  updatePendingActionCard(input: {
    cardId: number;
    payload?: ActionCard["payload"];
    sourceQuote?: string;
    disambiguation?: ActionCardDisambiguation | null;
  }): ActionCardRecord | null;
  countPendingLocalBatchInteractionCards(anchorCardId: number): number;
  clearAllData(): void;
  deleteScreenshotUploadArtifacts(screenshotId: number): void;
  listContacts(): ContactListItem[];
  getContactDetail(contactId: number): ContactDetail | null;
  listMeetings(): MeetingRecord[];
  getScreenshotDetail(screenshotId: number): ScreenshotDetail | null;
}

export type LoadedScreenshotImage = {
  image: {
    base64: string;
    mimeType: string;
  };
  imagePath: string;
};

export type ScreenshotImageLoader = (
  asset: UploadImageAsset,
) => Promise<LoadedScreenshotImage>;
