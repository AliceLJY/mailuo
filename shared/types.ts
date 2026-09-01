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

export const MEETING_KINDS = ["meeting", "appointment", "other"] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export function isMeetingKind(value: unknown): value is MeetingKind {
  return MEETING_KINDS.includes(value as MeetingKind);
}

export type CreateMeetingPayload = {
  // Cards saved before schema v1 have no kind; validation upgrades them to meeting on confirmation.
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

export type ActionCardConfidence = "high" | "medium" | "low";
export type ActionCardStatus = "pending" | "confirmed" | "rejected";
export type ActionCardType =
  | "create_contact"
  | "update_contact"
  | "create_meeting"
  | "record_interaction";

export type ActionCardDisambiguation = {
  candidates: Array<{
    contact_id: number;
    name: string;
    company?: string | null;
  }>;
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

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type HealthResponse = {
  status: "ok";
  now: string;
};

export type ScreenshotUploadResponse = {
  screenshot_id: number;
  cards: ActionCardRecord[];
};
