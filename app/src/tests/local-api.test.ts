import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContactFieldUpdates,
  MeetingParticipant,
  ObservationInsertInput,
  ObservationKind,
  StoredActionCardRecord,
} from "../../../shared/core/agent/execute.ts";
import type {
  ChatCompletionRequest,
  StructuredOutputProvider,
  StructuredOutputRequest,
} from "../../../shared/core/llm/provider.ts";
import type {
  ActionCardRecord,
  ContactDetail,
  ContactListItem,
  ContactRecord,
  InsightRecord,
  MeetingRecord,
  ObservationRecord,
  ScreenshotDetail,
  ScreenshotRecord,
} from "../types";
import { createLocalApi } from "../local/api";
import type { LocalStore } from "../local/types";
import type { LocalLlmSecretStore } from "../connection/secrets";

const FIXED_NOW = new Date("2026-08-27T04:00:00.000Z");

class FakeStructuredOutputProvider implements StructuredOutputProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls = 0;

  constructor(private readonly response: () => unknown) {}

  async complete(_request: ChatCompletionRequest): Promise<string> {
    throw new Error("complete is not used by this test");
  }

  async generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T> {
    this.calls += 1;
    return request.schema.parse(this.response());
  }
}

class FakeLocalStore implements LocalStore {
  private screenshotId = 0;
  private cardId = 0;
  private contactId = 0;
  private observationId = 0;
  private meetingId = 0;
  private insightId = 0;

  private readonly screenshots = new Map<number, ScreenshotRecord>();
  private readonly cards = new Map<number, ActionCardRecord>();
  private readonly contacts = new Map<number, ContactRecord>();
  private readonly observations: ObservationRecord[] = [];
  private readonly meetings: MeetingRecord[] = [];
  private readonly insights: InsightRecord[] = [];

  withTransaction<T>(callback: () => T): T {
    return callback();
  }

  createScreenshot(input: Parameters<LocalStore["createScreenshot"]>[0]): ScreenshotRecord {
    const record: ScreenshotRecord = {
      id: ++this.screenshotId,
      image_path: input.imagePath,
      user_note: input.userNote ?? null,
      raw_extraction: null,
      uploaded_at: input.uploadedAt ?? FIXED_NOW.toISOString(),
    };
    this.screenshots.set(record.id, record);
    return record;
  }

  saveScreenshotAnalysis(
    input: Parameters<LocalStore["saveScreenshotAnalysis"]>[0],
  ): ActionCardRecord[] {
    const screenshot = this.screenshots.get(input.screenshotId);

    if (!screenshot) {
      throw new Error("missing screenshot");
    }

    this.screenshots.set(input.screenshotId, {
      ...screenshot,
      raw_extraction: input.rawExtraction as ScreenshotRecord["raw_extraction"],
    });

    return input.cards.map((card) => {
      const record = {
        ...card,
        id: ++this.cardId,
        screenshot_id: input.screenshotId,
        disambiguation: card.disambiguation ?? null,
        status: "pending" as const,
        created_at: input.createdAt ?? FIXED_NOW.toISOString(),
        resolved_contact_id: null,
        resolved_at: null,
      } as ActionCardRecord;
      this.cards.set(record.id, record);
      return record;
    });
  }

  deleteScreenshotUploadArtifacts(screenshotId: number): void {
    for (const [id, card] of this.cards) {
      if (card.screenshot_id === screenshotId) {
        this.cards.delete(id);
      }
    }
    this.screenshots.delete(screenshotId);
  }

  getScreenshotById(screenshotId: number): ScreenshotRecord | null {
    return this.screenshots.get(screenshotId) ?? null;
  }

  getScreenshotDetail(screenshotId: number): ScreenshotDetail | null {
    const screenshot = this.getScreenshotById(screenshotId);

    if (!screenshot) {
      return null;
    }

    return {
      ...screenshot,
      cards: [...this.cards.values()].filter((card) => card.screenshot_id === screenshotId),
    };
  }

  getStoredActionCardById(cardId: number): StoredActionCardRecord | null {
    return this.cards.get(cardId) ?? null;
  }

  findResolvedContactIdsForConfirmedSiblingCreateCards(args: {
    screenshotId: number;
    displayedNames: string[];
  }): number[] {
    const names = new Set(args.displayedNames.map((name) => name.trim().toLowerCase()));
    const ids = new Set<number>();

    for (const card of this.cards.values()) {
      if (
        card.screenshot_id !== args.screenshotId ||
        card.type !== "create_contact" ||
        card.status !== "confirmed" ||
        card.resolved_contact_id == null
      ) {
        continue;
      }

      if (
        [card.payload.name, ...(card.payload.aliases ?? [])].some((name) =>
          names.has(name.trim().toLowerCase()),
        )
      ) {
        ids.add(card.resolved_contact_id);
      }
    }

    return [...ids];
  }

  confirmActionCardIfPending(
    input: Parameters<LocalStore["confirmActionCardIfPending"]>[0],
  ): StoredActionCardRecord | null {
    const current = this.cards.get(input.cardId);

    if (!current || current.status !== "pending") {
      return null;
    }

    const confirmed = {
      ...current,
      payload: input.payload ?? current.payload,
      status: "confirmed" as const,
      resolved_contact_id: input.resolvedContactId ?? null,
      resolved_at: input.resolvedAt,
    } as ActionCardRecord;
    this.cards.set(confirmed.id, confirmed);
    return confirmed;
  }

  rejectActionCardIfPending(
    cardId: number,
    resolvedAt = FIXED_NOW.toISOString(),
  ): StoredActionCardRecord | null {
    const current = this.cards.get(cardId);

    if (!current || current.status !== "pending") {
      return null;
    }

    const rejected = {
      ...current,
      status: "rejected" as const,
      resolved_at: resolvedAt,
    };
    this.cards.set(cardId, rejected);
    return rejected;
  }

  createContact(input: Parameters<LocalStore["createContact"]>[0]): ContactRecord {
    const createdAt = input.createdAt ?? FIXED_NOW.toISOString();
    const contact: ContactRecord = {
      id: ++this.contactId,
      canonical_name: input.canonicalName,
      aliases: [...new Set(input.aliases ?? [])],
      company: input.company ?? null,
      title: input.title ?? null,
      phone: input.phone ?? null,
      wechat_id: input.wechat_id ?? null,
      tags: [],
      notes: input.notes ?? null,
      created_at: createdAt,
      updated_at: input.updatedAt ?? createdAt,
    };
    this.contacts.set(contact.id, contact);
    return contact;
  }

  getContactById(contactId: number): ContactRecord | null {
    return this.contacts.get(contactId) ?? null;
  }

  appendContactAliases(
    contactId: number,
    aliases: string[],
    updatedAt = FIXED_NOW.toISOString(),
  ): ContactRecord | null {
    const contact = this.contacts.get(contactId);

    if (!contact) {
      return null;
    }

    const updated = {
      ...contact,
      aliases: [...new Set([...contact.aliases, ...aliases])].filter(
        (alias) => alias !== contact.canonical_name,
      ),
      updated_at: updatedAt,
    };
    this.contacts.set(contactId, updated);
    return updated;
  }

  updateContactFields(
    contactId: number,
    updates: ContactFieldUpdates,
    updatedAt = FIXED_NOW.toISOString(),
  ): ContactRecord | null {
    const contact = this.contacts.get(contactId);

    if (!contact) {
      return null;
    }

    const updated = { ...contact, ...updates, updated_at: updatedAt };
    this.contacts.set(contactId, updated);
    return updated;
  }

  listContacts(): ContactListItem[] {
    return [...this.contacts.values()].map((contact) => {
      const related = this.observations.filter((item) => item.contact_id === contact.id);
      const lastInteraction = related
        .filter((item) => item.kind === "interaction")
        .map((item) => item.observed_at)
        .sort()
        .at(-1) ?? null;

      return {
        ...contact,
        observation_count: related.length,
        last_interaction_at: lastInteraction,
      };
    });
  }

  getContactDetail(contactId: number): ContactDetail | null {
    const contact = this.contacts.get(contactId);

    if (!contact) {
      return null;
    }

    return {
      contact,
      observations: this.observations.filter((item) => item.contact_id === contactId),
      insights: this.insights.filter((item) => item.contact_id === contactId),
    };
  }

  findObservationByContactAndScreenshot(input: {
    contactId: number;
    screenshotId: number | null;
    kind: ObservationKind;
  }): ObservationRecord | null {
    return this.observations.find(
      (item) =>
        item.contact_id === input.contactId &&
        item.screenshot_id === input.screenshotId &&
        item.kind === input.kind,
    ) ?? null;
  }

  insertObservationIfAbsent(input: ObservationInsertInput): ObservationRecord {
    const screenshotId = input.screenshotId ?? null;
    const sourceQuote = input.sourceQuote ?? null;
    const existing = this.observations.find(
      (item) =>
        item.contact_id === input.contactId &&
        item.screenshot_id === screenshotId &&
        item.kind === input.kind &&
        item.content === input.content &&
        item.source_quote === sourceQuote,
    );

    if (existing) {
      return existing;
    }

    const observation: ObservationRecord = {
      id: ++this.observationId,
      contact_id: input.contactId,
      screenshot_id: screenshotId,
      kind: input.kind,
      content: input.content,
      source_quote: sourceQuote,
      observed_at: input.observedAt ?? FIXED_NOW.toISOString(),
    };
    this.observations.push(observation);
    return observation;
  }

  insertMeeting(input: Parameters<LocalStore["insertMeeting"]>[0]): MeetingRecord {
    const meeting: MeetingRecord = {
      id: ++this.meetingId,
      title: input.title,
      time_iso: input.timeIso,
      time_text: input.timeText,
      location: input.location ?? null,
      participants: input.participants,
      agenda: input.agenda ?? null,
      source_screenshot_id: input.sourceScreenshotId ?? null,
      status: "upcoming",
      created_at: input.createdAt ?? FIXED_NOW.toISOString(),
    };
    this.meetings.push(meeting);
    return meeting;
  }

  listMeetings(): MeetingRecord[] {
    return [...this.meetings];
  }

  getInsightContext(contactId: number) {
    const detail = this.getContactDetail(contactId);

    if (!detail) {
      return null;
    }

    return {
      contact: detail.contact,
      observations: detail.observations,
      recentInsights: detail.insights.slice(-5),
    };
  }

  insertInsights(entries: Parameters<LocalStore["insertInsights"]>[0]) {
    return entries.map((entry) => {
      const insight: InsightRecord = {
        id: ++this.insightId,
        contact_id: entry.contact_id,
        kind: entry.kind,
        content: entry.content,
        based_on: entry.based_on,
        generated_at: entry.generated_at,
      };
      this.insights.push(insight);
      return insight;
    });
  }
}

const fakeKeys: LocalLlmSecretStore = {
  async get(name) {
    return name.endsWith("MODEL") ? null : "injected-test-value";
  },
  async set() {},
  async clear() {},
  async clearAll() {},
};

test("local orchestration reaches terminal contacts, observations, meetings, and insights", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => ({
    participants: [
      {
        name: "我",
        is_self: true,
        confidence: "high",
        source_quote: "我和小林约好了",
      },
      {
        name: "小林",
        is_self: false,
        title: "产品经理",
        interaction_summary: "讨论了下周的产品评审",
        confidence: "high",
        source_quote: "小林是产品经理，我们讨论了下周的产品评审",
      },
    ],
    events: [
      {
        kind: "meeting",
        title: "产品评审",
        time_text: "8月29日上午10点",
        time_iso: "2026-08-29T10:00:00+08:00",
        has_time_signal: true,
        location: "会议室 A",
        participant_names: ["我", "小林"],
        confidence: "high",
        source_quote: "8月29日上午10点在会议室 A 做产品评审",
      },
    ],
    facts: [
      {
        subject_name: "小林",
        field: "other",
        value: "喜欢手冲咖啡",
        confidence: "medium",
        source_quote: "小林喜欢手冲咖啡",
      },
    ],
    quotes: [],
  }));
  const deepSeek = new FakeStructuredOutputProvider(() => ({
    insights: [
      {
        kind: "conversation_hook",
        content: "下次可以从产品评审进展聊起",
        based_on: [1],
      },
    ],
  }));
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async (asset) => ({
      image: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      imagePath: asset.uri,
    }),
    providers: {
      async createQwenProvider() {
        return qwen;
      },
      async createTextProvider() {
        return deepSeek;
      },
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/screenshot.png", mimeType: "image/png" },
    note: "  产品评审截图  ",
  });

  assert.deepEqual(
    upload.cards.map((card) => card.type),
    ["create_contact", "create_meeting", "record_interaction"],
  );

  for (const card of upload.cards) {
    const result = await api.confirmCard(card.id);
    assert.equal(result.executed, true);
    assert.equal(result.card.status, "confirmed");
    assert.equal(result.insight_status, "ok");
  }

  const contacts = await api.getContacts();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].canonical_name, "小林");
  assert.equal(contacts[0].observation_count, 3);

  const detail = await api.getContactDetail(contacts[0].id);
  assert.deepEqual(
    new Set(detail.observations.map((item) => item.kind)),
    new Set(["fact", "preference", "interaction"]),
  );
  assert.equal(detail.insights.length, 3);

  const meetings = await api.getMeetings();
  assert.equal(meetings.length, 1);
  assert.deepEqual(meetings[0].participants, [
    { name: "我" },
    { contact_id: contacts[0].id, name: "小林" },
  ] satisfies MeetingParticipant[]);

  const screenshot = await api.getScreenshotDetail(upload.screenshot_id);
  assert.equal(screenshot.user_note, "产品评审截图");
  assert.ok(screenshot.cards.every((card) => card.status === "confirmed"));
  assert.equal(qwen.calls, 1);
  assert.equal(deepSeek.calls, 3);
});
