import type {
  ContactFieldUpdates,
  ExecuteStore,
  MeetingWriteInput,
} from "../../../shared/core/agent/execute.ts";
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

export interface LocalStore extends ExecuteStore, InsightGenerationDb, DiagnosticsDataSource {
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
  // Restores a rejected card back to pending, clearing its resolution — the inverse of
  // rejectActionCardIfPending (inherited from ExecuteStore). Returns null when the card
  // is missing or not currently rejected, matching that method's null-on-mismatch contract.
  reopenActionCardIfRejected(cardId: number): ActionCardRecord | null;
  countPendingLocalBatchInteractionCards(anchorCardId: number): number;
  clearAllData(): void;
  deleteScreenshotUploadArtifacts(screenshotId: number): void;
  listContacts(): ContactListItem[];
  getContactDetail(contactId: number): ContactDetail | null;
  listMeetings(): MeetingRecord[];
  getScreenshotDetail(screenshotId: number): ScreenshotDetail | null;
  // ExecuteStore already declares updateMeeting/updateContactFields, but with narrower
  // return types ({id:number}|null / execute.ts's own tags-less ContactRecord) that only
  // cover what the confirm-card flow needs. The concrete store already returns the fuller
  // app-level record at runtime (fix16 v3-M4); these overrides just expose that existing
  // return shape through the LocalStore interface so callers here get the full record
  // back without a second read.
  updateMeeting(meetingId: number, input: MeetingWriteInput): MeetingRecord | null;
  updateContactFields(
    contactId: number,
    updates: ContactFieldUpdates,
    updatedAt?: string,
  ): ContactRecord | null;
  // fix16: ContactEditPatch also lets callers rename a contact or replace its aliases/tags,
  // none of which CONTACT_EDITABLE_FIELDS covers (it's confirm-card scoped to
  // company/title/phone/wechat_id/notes). New, narrowly-scoped method rather than widening
  // updateContactFields, so that existing method stays untouched.
  updateContactIdentity(
    contactId: number,
    updates: { canonical_name?: string; aliases?: string[]; tags?: string[] },
    updatedAt?: string,
  ): ContactRecord | null;
  deleteMeeting(meetingId: number): boolean;
  deleteContact(contactId: number): boolean;
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
