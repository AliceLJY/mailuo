import type { MeetingKind } from "../../shared/types.ts";

export type ActionCardConfidence = "high" | "medium" | "low";
export type ActionCardStatus = "pending" | "confirmed" | "rejected";
export type ActionCardType =
  | "create_contact"
  | "update_contact"
  | "create_meeting"
  | "record_interaction";

export type CreateContactPayload = {
  name: string;
  aliases?: string[];
  company?: string;
  title?: string;
  phone?: string;
  wechat_id?: string;
  notes?: string;
};

export type UpdateContactPayload = {
  contact_id: number;
  contact_name: string;
  changes: Record<string, { old: string | null; new: string }>;
};

export type CreateMeetingPayload = {
  kind?: MeetingKind;
  title: string;
  time_iso: string | null;
  time_text: string;
  location?: string;
  participants: Array<{ contact_id?: number; name: string }>;
  agenda?: string;
};

export type RecordInteractionPayload = {
  contact_id?: number;
  contact_name: string;
  summary: string;
};

export type LocalBatchDeferredDependency =
  | {
      kind: "meeting_participant";
      anchor_card_id: number;
      participant_index: number;
    }
  | {
      kind: "record_interaction";
      anchor_card_id: number;
    }
  | {
      kind: "disambiguation_candidate";
      anchor_card_id: number;
      candidate: {
        name: string;
        company?: string | null;
      };
    };

export type LocalBatchDeferredMarker = {
  version: 1;
  dependencies: LocalBatchDeferredDependency[];
};

export type ActionCardDisambiguation = {
  candidates: Array<{
    contact_id: number;
    name: string;
    company?: string | null;
  }>;
  local_batch_deferred?: LocalBatchDeferredMarker;
};

type ActionCardBase<TType extends ActionCardType, TPayload> = {
  type: TType;
  payload: TPayload;
  confidence: ActionCardConfidence;
  source_quote: string;
  disambiguation?: ActionCardDisambiguation | null;
};

export type CreateContactCard = ActionCardBase<
  "create_contact",
  CreateContactPayload
>;
export type UpdateContactCard = ActionCardBase<
  "update_contact",
  UpdateContactPayload
>;
export type CreateMeetingCard = ActionCardBase<
  "create_meeting",
  CreateMeetingPayload
>;
export type RecordInteractionCard = ActionCardBase<
  "record_interaction",
  RecordInteractionPayload
>;

export type ActionCard =
  | CreateContactCard
  | UpdateContactCard
  | CreateMeetingCard
  | RecordInteractionCard;

export type ActionCardRecord = ActionCard & {
  id: number;
  screenshot_id: number;
  status: ActionCardStatus;
  created_at: string;
  resolved_contact_id: number | null;
  resolved_at: string | null;
};

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = {
  ok: false;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type ContactRecord = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat_id: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactListItem = ContactRecord & {
  observation_count: number;
  last_interaction_at: string | null;
};

export type ObservationKind =
  | "fact"
  | "preference"
  | "status_change"
  | "interaction";

export type ObservationRecord = {
  id: number;
  contact_id: number;
  screenshot_id: number | null;
  kind: ObservationKind;
  content: string;
  source_quote: string | null;
  observed_at: string;
};

export type MeetingRecord = {
  id: number;
  kind: MeetingKind;
  title: string;
  time_iso: string | null;
  time_text: string;
  location: string | null;
  participants: Array<{ contact_id?: number; name: string }>;
  agenda: string | null;
  source_screenshot_id: number | null;
  status: string;
  created_at: string;
};

export type InsightKind =
  | "relationship_read"
  | "suggested_action"
  | "conversation_hook";

export type InsightRecord = {
  id: number;
  contact_id: number;
  kind: InsightKind;
  content: string;
  based_on: number[];
  generated_at: string;
};

export type ContactDetail = {
  contact: ContactRecord;
  observations: ObservationRecord[];
  insights: InsightRecord[];
};

export type RawExtraction = {
  participants: Array<{
    name: string;
    is_self?: boolean;
    aliases?: string[];
    company?: string;
    title?: string;
    phone?: string;
    wechat_id?: string;
    notes?: string;
    confidence?: ActionCardConfidence;
    source_quote?: string;
  }>;
  events: Array<{
    kind: "meeting" | "appointment" | "other";
    title: string;
    time_text: string;
    time_iso: string | null;
    has_time_signal?: boolean;
    location?: string;
    participant_names?: string[];
    agenda?: string;
    confidence?: ActionCardConfidence;
    source_quote?: string;
  }>;
  facts: Array<{
    subject_name: string;
    field: "alias" | "company" | "title" | "phone" | "wechat_id" | "notes" | "other";
    value: string;
    confidence?: ActionCardConfidence;
    source_quote?: string;
  }>;
  quotes: Array<{
    speaker_name: string | null;
    text: string;
    source_quote: string;
  }>;
};

export type ScreenshotRecord = {
  id: number;
  image_path: string;
  user_note: string | null;
  raw_extraction: RawExtraction | null;
  uploaded_at: string;
};

export type ScreenshotDetail = ScreenshotRecord & {
  cards: ActionCardRecord[];
};

export type HealthResponse = {
  status: "ok";
  now: string;
};

export type ScreenshotUploadResponse = {
  screenshot_id: number;
  cards: ActionCardRecord[];
  processing_notice?: string;
  local_batch_contact_merges?: LocalBatchContactMerge[];
};

export type LocalBatchContactEvidence = {
  screenshot_id: number;
  source_quotes: string[];
};

export type LocalBatchContactMerge = {
  anchor_card: ActionCardRecord;
  evidence: LocalBatchContactEvidence[];
};

export type ConfirmCardRequest = {
  payload?: ActionCard["payload"];
  resolved_contact_id?: number;
};

export type ReviewCardDraft = {
  payload: ActionCard["payload"];
  resolved_contact_id: number | null;
};

export type ConfirmCardResponse = {
  executed: true;
  card: ActionCardRecord;
  affected_contact_ids: number[];
  observation_ids: number[];
  meeting_id?: number;
  insight_status: "ok" | "failed";
  insight_error?: string;
  insights: InsightRecord[];
};

export type RejectCardResponse = {
  card: ActionCardRecord;
};

export type UploadImageAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  width?: number;
  height?: number;
};
