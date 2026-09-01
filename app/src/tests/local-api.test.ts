import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContactFieldUpdates,
  MeetingParticipant,
  ObservationInsertInput,
  ObservationKind,
  StoredActionCardRecord,
} from "../../../shared/core/agent/execute.ts";
import type { PerceptionResult } from "../../../shared/core/agent/perceive.ts";
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
import {
  hydrateLocalBatchCardForResponse,
  LocalBatchContactMappingError,
  LocalBatchContactSession,
} from "../local/batch-contacts";
import { perceiveScreenshotWithOcr, type OcrPerceptionResult } from "../local/perceive-ocr";
import type { LocalStore } from "../local/types";
import type { LocalLlmSecretStore } from "../connection/secrets";

const FIXED_NOW = new Date("2026-08-27T04:00:00.000Z");

class FakeStructuredOutputProvider implements StructuredOutputProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls = 0;
  completeCalls = 0;

  constructor(
    private readonly response: () => unknown,
    private readonly completionResponse: () => string = () => {
      throw new Error("complete is not used by this test");
    },
  ) {}

  async complete(_request: ChatCompletionRequest): Promise<string> {
    this.completeCalls += 1;
    return this.completionResponse();
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
  transactionCalls = 0;
  pendingCardUpdateCalls = 0;
  listMeetingCalls = 0;

  withTransaction<T>(callback: () => T): T {
    this.transactionCalls += 1;
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

    for (const update of input.pendingCardUpdates ?? []) {
      const updated = this.updatePendingActionCard(update);
      if (!updated) {
        throw new Error(`missing pending card ${update.cardId}`);
      }
    }

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

  updatePendingActionCard(
    input: Parameters<LocalStore["updatePendingActionCard"]>[0],
  ): ActionCardRecord | null {
    this.pendingCardUpdateCalls += 1;
    const current = this.cards.get(input.cardId);

    if (!current || current.status !== "pending") {
      return null;
    }

    const updated = {
      ...current,
      payload: input.payload ?? current.payload,
      source_quote: input.sourceQuote ?? current.source_quote,
      disambiguation: input.disambiguation === undefined
        ? current.disambiguation
        : input.disambiguation,
    } as ActionCardRecord;
    this.cards.set(updated.id, updated);
    return updated;
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
      kind: input.kind,
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

  updateMeeting(
    meetingId: number,
    input: Parameters<LocalStore["updateMeeting"]>[1],
  ): MeetingRecord | null {
    const index = this.meetings.findIndex((meeting) => meeting.id === meetingId);
    const existing = this.meetings[index];

    if (!existing) {
      return null;
    }

    const meeting: MeetingRecord = {
      ...existing,
      kind: input.kind,
      title: input.title,
      time_iso: input.timeIso,
      time_text: input.timeText,
      location: input.location ?? null,
      participants: input.participants,
      agenda: input.agenda ?? null,
      source_screenshot_id: input.sourceScreenshotId ?? null,
    };
    this.meetings[index] = meeting;
    return meeting;
  }

  listMeetings(): MeetingRecord[] {
    this.listMeetingCalls += 1;
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

function collectContactIds(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectContactIds);
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const ids: number[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === "contact_id" && typeof entry === "number") {
      ids.push(entry);
    }
    ids.push(...collectContactIds(entry));
  }
  return ids;
}

test("local batch merges pending contacts and maps every deferred contact id before execution", async () => {
  const store = new FakeLocalStore();
  const extractions = [
    {
      participants: [{
        name: "张三",
        is_self: false,
        company: "甲公司",
        interaction_summary: "聊了项目近况",
        confidence: "high" as const,
        source_quote: "张三：我现在在甲公司",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    {
      participants: [{
        name: "张三",
        is_self: false,
        title: "产品总监",
        interaction_summary: "约了周一复盘",
        confidence: "high" as const,
        source_quote: "张三：我升产品总监了，周一复盘",
      }],
      events: [{
        kind: "meeting" as const,
        title: "项目复盘",
        time_text: "周一上午十点",
        time_iso: "2026-08-31T10:00:00+08:00",
        has_time_signal: true,
        participant_names: ["张三"],
        confidence: "high" as const,
        source_quote: "周一上午十点做项目复盘",
      }],
      facts: [],
      quotes: [],
    },
    {
      participants: [],
      events: [],
      facts: [],
      quotes: [],
    },
  ];
  const qwen = new FakeStructuredOutputProvider(() => {
    const extraction = extractions.shift();
    if (!extraction) {
      throw new Error("unexpected perception call");
    }
    return extraction;
  });
  const text = new FakeStructuredOutputProvider(() => ({ insights: [] }));
  const createApi = () => createLocalApi({
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
        return text;
      },
    },
    now: () => new Date(FIXED_NOW),
  });
  const api = createApi();
  const session = new LocalBatchContactSession();

  const first = await api.uploadScreenshot({
    asset: { uri: "file:///fake/batch-1.png", mimeType: "image/png" },
    localBatch: { session, index: 0 },
  });
  const anchor = first.cards.find((card) => card.type === "create_contact");
  assert.ok(anchor);
  assert.deepEqual(session.listPendingContacts().map((contact) => contact.id), [-1]);

  const second = await api.uploadScreenshot({
    asset: { uri: "file:///fake/batch-2.png", mimeType: "image/png" },
    localBatch: { session, index: 1 },
  });
  assert.equal(
    [...first.cards, ...second.cards].filter((card) => card.type === "create_contact").length,
    1,
  );
  assert.deepEqual(second.cards.map((card) => card.type), [
    "create_meeting",
    "record_interaction",
  ]);

  const merge = second.local_batch_contact_merges?.[0];
  assert.ok(merge);
  assert.equal(merge.anchor_card.id, anchor.id);
  assert.equal(merge.anchor_card.type, "create_contact");
  assert.equal(merge.anchor_card.payload.title, "产品总监");
  assert.deepEqual(merge.evidence.map((entry) => entry.screenshot_id), [
    first.screenshot_id,
    second.screenshot_id,
  ]);
  assert.match(merge.anchor_card.source_quote, /我现在在甲公司/u);
  assert.match(merge.anchor_card.source_quote, /我升产品总监了/u);

  for (const screenshotId of [first.screenshot_id, second.screenshot_id]) {
    const detail = await api.getScreenshotDetail(screenshotId);
    for (const card of detail.cards) {
      assert.ok(collectContactIds(card).every((contactId) => contactId >= 0));
    }
  }

  const interaction = second.cards.find((card) => card.type === "record_interaction");
  const meeting = second.cards.find((card) => card.type === "create_meeting");
  assert.ok(interaction);
  assert.ok(meeting);
  const storedInteraction = store.getStoredActionCardById(interaction.id) as ActionCardRecord;
  assert.deepEqual(
    storedInteraction.disambiguation?.local_batch_deferred?.dependencies,
    [{ kind: "record_interaction", anchor_card_id: anchor.id }],
  );
  assert.ok(collectContactIds(storedInteraction).every((contactId) => contactId >= 0));

  const rebuiltApi = createApi();
  const transactionsBeforeMissingMapping = store.transactionCalls;
  const writesBeforeMissingMapping = store.pendingCardUpdateCalls;
  await assert.rejects(rebuiltApi.confirmCard(interaction.id), LocalBatchContactMappingError);
  assert.equal(store.transactionCalls, transactionsBeforeMissingMapping);
  assert.equal(store.pendingCardUpdateCalls, writesBeforeMissingMapping);
  assert.equal((await rebuiltApi.getScreenshotDetail(second.screenshot_id)).cards
    .find((card) => card.id === interaction.id)?.status, "pending");
  assert.equal((await rebuiltApi.getContacts()).length, 0);

  const createResult = await rebuiltApi.confirmCard(anchor.id, {
    payload: merge.anchor_card.payload,
  });
  const realContactId = createResult.card.resolved_contact_id;
  assert.ok(realContactId && realContactId > 0);
  assert.equal((await rebuiltApi.getContacts())[0]?.title, "产品总监");

  const meetingResult = await rebuiltApi.confirmCard(meeting.id);
  const interactionResult = await rebuiltApi.confirmCard(interaction.id);
  assert.equal(meetingResult.card.type, "create_meeting");
  assert.equal(interactionResult.card.type, "record_interaction");
  if (meetingResult.card.type !== "create_meeting" || interactionResult.card.type !== "record_interaction") {
    throw new Error("unexpected confirmed card types");
  }
  assert.equal(meetingResult.card.payload.participants[0]?.contact_id, realContactId);
  assert.equal(interactionResult.card.payload.contact_id, realContactId);
  assert.equal((await rebuiltApi.getMeetings())[0]?.participants[0]?.contact_id, realContactId);

  const contact = await rebuiltApi.getContactDetail(realContactId);
  assert.ok(contact.observations.some((observation) =>
    observation.screenshot_id === second.screenshot_id && observation.contact_id === realContactId));
  for (const screenshotId of [first.screenshot_id, second.screenshot_id]) {
    const detail = await rebuiltApi.getScreenshotDetail(screenshotId);
    for (const card of detail.cards) {
      assert.ok(collectContactIds(card).every((contactId) => contactId >= 0));
    }
  }
  assert.deepEqual(session.listPendingContacts().map((pending) => pending.id), [-1]);
  await api.uploadScreenshot({
    asset: { uri: "file:///fake/batch-3.png", mimeType: "image/png" },
    localBatch: { session, index: 2 },
  });
  assert.deepEqual(session.listPendingContacts(), []);
});

test("local batch keeps temporary disambiguation candidates out of storage and maps a selected one", () => {
  const session = new LocalBatchContactSession();
  const firstExtraction = {
    participants: [{
      name: "张三",
      is_self: false,
      confidence: "high" as const,
      source_quote: "张三：你好",
    }],
    events: [],
    facts: [],
    quotes: [],
  };
  const firstPlan = session.prepareScreenshot({
    screenshotId: 1,
    batchIndex: 0,
    extraction: firstExtraction,
    resolutions: [{
      participant_name: "张三",
      normalized_name: "张三",
      status: "new",
      source: "empty_db",
    }],
    cards: [{
      type: "create_contact",
      payload: { name: "张三" },
      confidence: "high",
      source_quote: "张三：你好",
    }],
  });
  const anchor = {
    ...firstPlan.cards[0],
    id: 11,
    screenshot_id: 1,
    disambiguation: null,
    status: "pending" as const,
    resolved_contact_id: null,
    created_at: FIXED_NOW.toISOString(),
    resolved_at: null,
  } as ActionCardRecord;
  session.commitScreenshot({
    plan: firstPlan,
    savedCards: [anchor],
    updatedAnchorCards: new Map(),
  });

  const secondPlan = session.prepareScreenshot({
    screenshotId: 2,
    batchIndex: 1,
    extraction: {
      participants: [{
        name: "老张",
        is_self: false,
        confidence: "medium" as const,
        source_quote: "老张：最近怎么样",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "老张",
      normalized_name: "老张",
      status: "unsure",
      candidate_ids: [-1],
      source: "llm",
    }],
    cards: [{
      type: "create_contact",
      payload: { name: "老张" },
      confidence: "medium",
      source_quote: "老张：最近怎么样",
      disambiguation: {
        candidates: [{ contact_id: -1, name: "张三", company: null }],
      },
    }],
  });
  assert.deepEqual(secondPlan.cards[0]?.disambiguation, {
    candidates: [],
    local_batch_deferred: {
      version: 1,
      dependencies: [{
        kind: "disambiguation_candidate",
        anchor_card_id: anchor.id,
        candidate: { name: "张三", company: null },
      }],
    },
  });
  const storedCandidateCard = {
    ...secondPlan.cards[0],
    id: 12,
    screenshot_id: 2,
    disambiguation: secondPlan.cards[0]?.disambiguation ?? null,
    status: "pending" as const,
    resolved_contact_id: null,
    created_at: FIXED_NOW.toISOString(),
    resolved_at: null,
  } as ActionCardRecord;
  const committed = session.commitScreenshot({
    plan: secondPlan,
    savedCards: [storedCandidateCard],
    updatedAnchorCards: new Map(),
  });
  assert.deepEqual(collectContactIds(storedCandidateCard), []);
  assert.deepEqual(committed.cards[0]?.disambiguation?.candidates.map((candidate) => candidate.contact_id), [-11]);
  assert.deepEqual(
    hydrateLocalBatchCardForResponse(storedCandidateCard, () => anchor)
      .disambiguation?.candidates.map((candidate) => candidate.contact_id),
    [-11],
  );
  assert.throws(
    () => session.prepareConfirmation({
      card: storedCandidateCard,
      payload: storedCandidateCard.payload,
      resolvedContactId: -11,
    }),
    LocalBatchContactMappingError,
  );

  session.registerConfirmedContact(anchor.id, 42);
  assert.deepEqual(
    hydrateLocalBatchCardForResponse(storedCandidateCard, () => ({
      ...anchor,
      status: "confirmed",
      resolved_contact_id: 42,
    })).disambiguation?.candidates.map((candidate) => candidate.contact_id),
    [42],
  );
  const prepared = session.prepareConfirmation({
    card: storedCandidateCard,
    payload: storedCandidateCard.payload,
    resolvedContactId: -11,
  });
  assert.equal(prepared.resolvedContactId, 42);
  assert.deepEqual(prepared.disambiguation?.candidates.map((candidate) => candidate.contact_id), [42]);
});

test("local batch retries merge fields and evidence by original batch index", () => {
  const session = new LocalBatchContactSession();
  const firstPlan = session.prepareScreenshot({
    screenshotId: 10,
    batchIndex: 0,
    extraction: {
      participants: [{
        name: "张三",
        is_self: false,
        company: "初始公司",
        title: "初始职位",
        confidence: "high",
        source_quote: "index-0 participant",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "张三",
      normalized_name: "张三",
      status: "new",
      source: "empty_db",
    }],
    cards: [{
      type: "create_contact",
      payload: { name: "张三", company: "初始公司", title: "初始职位" },
      confidence: "high",
      source_quote: "index-0 card",
    }],
  });
  let anchor = {
    ...firstPlan.cards[0],
    id: 21,
    screenshot_id: 10,
    disambiguation: firstPlan.cards[0]?.disambiguation ?? null,
    status: "pending" as const,
    resolved_contact_id: null,
    created_at: FIXED_NOW.toISOString(),
    resolved_at: null,
  } as ActionCardRecord;
  session.commitScreenshot({
    plan: firstPlan,
    savedCards: [anchor],
    updatedAnchorCards: new Map(),
  });

  const commitMerge = (plan: ReturnType<LocalBatchContactSession["prepareScreenshot"]>) => {
    const update = plan.pendingCardUpdates[0];
    assert.ok(update);
    anchor = {
      ...anchor,
      payload: update.payload,
      source_quote: update.sourceQuote,
    } as ActionCardRecord;
    const committed = session.commitScreenshot({
      plan,
      savedCards: [],
      updatedAnchorCards: new Map([[anchor.id, anchor]]),
    });
    assert.equal(committed.merges.length, 1);
    return committed.merges[0];
  };

  const newerPlan = session.prepareScreenshot({
    screenshotId: 30,
    batchIndex: 2,
    extraction: {
      participants: [{
        name: "张三",
        is_self: false,
        company: "新公司",
        confidence: "high",
        source_quote: "index-2 participant",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "张三",
      normalized_name: "张三",
      status: "same_as",
      contact_id: -1,
      source: "exact",
    }],
    cards: [{
      type: "update_contact",
      payload: {
        contact_id: -1,
        contact_name: "张三",
        changes: { title: { old: "初始职位", new: "新职位" } },
      },
      confidence: "high",
      source_quote: "index-2 update",
    }],
  });
  commitMerge(newerPlan);

  const retriedOlderPlan = session.prepareScreenshot({
    screenshotId: 20,
    batchIndex: 1,
    extraction: {
      participants: [{
        name: "张三",
        is_self: false,
        company: "旧重试公司",
        phone: "13800000000",
        confidence: "high",
        source_quote: "index-1 participant",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "张三",
      normalized_name: "张三",
      status: "same_as",
      contact_id: -1,
      source: "exact",
    }],
    cards: [{
      type: "update_contact",
      payload: {
        contact_id: -1,
        contact_name: "张三",
        changes: {
          title: { old: "初始职位", new: "旧重试职位" },
          wechat_id: { old: null, new: "wx-from-retry" },
        },
      },
      confidence: "high",
      source_quote: "index-1 update",
    }],
  });
  const merged = commitMerge(retriedOlderPlan);
  assert.equal(merged.anchor_card.type, "create_contact");
  if (merged.anchor_card.type !== "create_contact") {
    throw new Error("unexpected anchor card type");
  }
  assert.equal(merged.anchor_card.payload.company, "新公司");
  assert.equal(merged.anchor_card.payload.title, "新职位");
  assert.equal(merged.anchor_card.payload.phone, "13800000000");
  assert.equal(merged.anchor_card.payload.wechat_id, "wx-from-retry");
  assert.deepEqual(merged.evidence.map((entry) => entry.screenshot_id), [10, 20, 30]);
  const sourceQuote = merged.anchor_card.source_quote;
  assert.ok(sourceQuote.indexOf("index-0") < sourceQuote.indexOf("index-1"));
  assert.ok(sourceQuote.indexOf("index-1") < sourceQuote.indexOf("index-2"));
});

test("rejecting a local batch anchor removes stale pending contacts across API recreation", async () => {
  const runCase = async (recreateBeforeReject: boolean) => {
    const store = new FakeLocalStore();
    const extractions = [
      {
        participants: [{
          name: "张三",
          is_self: false,
          confidence: "high" as const,
          source_quote: "张三：你好",
        }],
        events: [],
        facts: [],
        quotes: [],
      },
      {
        participants: [{
          name: "张三",
          is_self: false,
          confidence: "high" as const,
          source_quote: "张三：再次上传",
        }],
        events: [],
        facts: [],
        quotes: [],
      },
    ];
    const qwen = new FakeStructuredOutputProvider(() => {
      const extraction = extractions.shift();
      if (!extraction) {
        throw new Error("unexpected perception call");
      }
      return extraction;
    });
    const text = new FakeStructuredOutputProvider(() => ({ insights: [] }));
    const createApi = () => createLocalApi({
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
          return text;
        },
      },
      now: () => new Date(FIXED_NOW),
    });
    const api = createApi();
    const session = new LocalBatchContactSession();
    const uploaded = await api.uploadScreenshot({
      asset: { uri: "file:///fake/reject-1.png", mimeType: "image/png" },
      localBatch: { session, index: 0 },
    });
    const anchor = uploaded.cards.find((card) => card.type === "create_contact");
    assert.ok(anchor);

    const rejectingApi = recreateBeforeReject ? createApi() : api;
    await rejectingApi.rejectCard(anchor.id);
    if (!recreateBeforeReject) {
      assert.deepEqual(session.listPendingContacts(), []);
      return;
    }

    assert.deepEqual(session.listPendingContacts().map((contact) => contact.id), [-1]);
    const retried = await api.uploadScreenshot({
      asset: { uri: "file:///fake/reject-2.png", mimeType: "image/png" },
      localBatch: { session, index: 1 },
    });
    assert.equal(
      retried.cards.filter((card) => card.type === "create_contact").length,
      1,
    );
    assert.deepEqual(session.listPendingContacts().map((contact) => contact.id), [-2]);
  };

  await runCase(false);
  await runCase(true);
});

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
  assert.equal(meetings[0].kind, "meeting");
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

const emptyExtraction = {
  participants: [],
  events: [],
  facts: [],
  quotes: [],
};

test("local text flow proposes and confirms a duplicate item as UPDATE, then creates a different title", async () => {
  const store = new FakeLocalStore();
  const existing = store.insertMeeting({
    kind: "other",
    title: "准备报名材料",
    timeIso: null,
    timeText: "",
    location: "一楼服务大厅",
    participants: [],
    agenda: "携带身份证复印件",
    createdAt: "2026-08-20T01:00:00.000Z",
  });
  const extractions: PerceptionResult[] = [
    {
      participants: [],
      events: [
        {
          kind: "other",
          title: "准备报名材料",
          time_text: "",
          time_iso: null,
          has_time_signal: false,
          participant_names: [],
          agenda: "携带身份证复印件和两张照片",
          confidence: "high",
          source_quote: "报名还要带两张照片",
        },
      ],
      facts: [],
      quotes: [],
    },
    {
      participants: [],
      events: [
        {
          kind: "other",
          title: "提交活动预算",
          time_text: "",
          time_iso: null,
          has_time_signal: false,
          participant_names: [],
          confidence: "high",
          source_quote: "活动预算周五前提交",
        },
      ],
      facts: [],
      quotes: [],
    },
  ];
  const textProvider = new FakeStructuredOutputProvider(() => ({ insights: [] }));
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    async loadImage() {
      throw new Error("text upload must not load an image");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("text upload must not create a vision provider");
      },
      async createTextProvider() {
        return textProvider;
      },
    },
    async perceiveOcrText() {
      const extraction = extractions.shift();
      if (!extraction) {
        throw new Error("unexpected text perception call");
      }
      return extraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const duplicateUpload = await api.uploadText({ text: "报名还要带两张照片" });
  const duplicateCard = duplicateUpload.cards.find((card) => card.type === "create_meeting");
  assert.ok(duplicateCard);
  assert.equal(duplicateCard.payload.duplicate_of_meeting_id, existing.id);
  assert.equal(duplicateCard.payload.location, "一楼服务大厅");
  assert.deepEqual(duplicateCard.payload.changes, {
    agenda: {
      old: "携带身份证复印件",
      new: "携带身份证复印件和两张照片",
    },
  });

  const updateResult = await api.confirmCard(duplicateCard.id);
  const afterUpdate = await api.getMeetings();
  assert.equal(updateResult.meeting_id, existing.id);
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0]?.id, existing.id);
  assert.equal(afterUpdate[0]?.agenda, "携带身份证复印件和两张照片");

  const newUpload = await api.uploadText({ text: "活动预算周五前提交" });
  const newCard = newUpload.cards.find((card) => card.type === "create_meeting");
  assert.ok(newCard);
  assert.equal(newCard.payload.duplicate_of_meeting_id, undefined);

  await api.confirmCard(newCard.id);
  assert.equal((await api.getMeetings()).length, 2);
});

test("pasted text uses the shared text perception path without loading or perceiving an image", async () => {
  const store = new FakeLocalStore();
  const textProvider = new FakeStructuredOutputProvider(() => emptyExtraction);
  let imageLoads = 0;
  let ocrCalls = 0;
  let qwenProviderCreations = 0;
  let textPerceptionCalls = 0;
  let perceivedLines: OcrPerceptionResult["lines"] = [];
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    async loadImage() {
      imageLoads += 1;
      throw new Error("text upload must not load an image");
    },
    providers: {
      async createQwenProvider() {
        qwenProviderCreations += 1;
        return new FakeStructuredOutputProvider(() => emptyExtraction);
      },
      async createTextProvider() {
        return textProvider;
      },
    },
    async perceiveOcr() {
      ocrCalls += 1;
      return { lines: [], warnings: [], degraded: false };
    },
    async perceiveOcrText(input) {
      textPerceptionCalls += 1;
      perceivedLines = input.ocr.lines;
      return emptyExtraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadText({
    text: "  明天上午 9:30 开会\n会议室 A  ",
    note: "  项目群通知  ",
  });
  const detail = await api.getScreenshotDetail(upload.screenshot_id);

  assert.equal(textPerceptionCalls, 1);
  assert.deepEqual(
    perceivedLines.map(({ text, side, x, y, width, height, confidence }) => ({
      text,
      side,
      x,
      y,
      width,
      height,
      confidence,
    })),
    [
      {
        text: "明天上午 9:30 开会",
        side: null,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        confidence: null,
      },
      {
        text: "会议室 A",
        side: null,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        confidence: null,
      },
    ],
  );
  assert.equal(imageLoads, 0);
  assert.equal(ocrCalls, 0);
  assert.equal(qwenProviderCreations, 0);
  assert.match(detail?.image_path ?? "", /^data:text\/plain;charset=utf-8,/u);
  assert.equal(
    decodeURIComponent((detail?.image_path ?? "").split(",", 2)[1] ?? ""),
    "明天上午 9:30 开会\n会议室 A",
  );
  assert.equal(detail?.user_note, "项目群通知");
  assert.deepEqual(detail?.raw_extraction, emptyExtraction);
});

async function runOcrFallbackCase(
  perceiveOcr: () => Promise<OcrPerceptionResult>,
  perceiveText: () => Promise<typeof emptyExtraction> = async () => emptyExtraction,
  expectedTextPerceptionCalls = 0,
) {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let textPerceptionCalls = 0;
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
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false };
    },
    perceiveOcr,
    async perceiveOcrText() {
      textPerceptionCalls += 1;
      return perceiveText();
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/fallback.png", mimeType: "image/png" },
  });

  assert.equal(qwen.calls, 1);
  assert.equal(textPerceptionCalls, expectedTextPerceptionCalls);
  assert.match(upload.processing_notice ?? "", /已用云端模型重新处理/u);
  assert.ok(await api.getScreenshotDetail(upload.screenshot_id));

  return upload;
}

async function runOcrTextOnlyCase(ocr: OcrPerceptionResult) {
  const store = new FakeLocalStore();
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let qwenProviderCreations = 0;
  let textPerceptionCalls = 0;
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async (asset) => ({
      image: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      imagePath: asset.uri,
    }),
    providers: {
      async createQwenProvider() {
        qwenProviderCreations += 1;
        return new FakeStructuredOutputProvider(() => emptyExtraction);
      },
      async createTextProvider() {
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false };
    },
    async perceiveOcr() {
      return ocr;
    },
    async perceiveOcrText() {
      textPerceptionCalls += 1;
      return emptyExtraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/unresolved-speakers.png", mimeType: "image/png" },
  });

  assert.equal(textPerceptionCalls, 1);
  assert.equal(qwenProviderCreations, 0);
  assert.match(upload.processing_notice ?? "", /发言人未能确定/u);
  assert.doesNotMatch(upload.processing_notice ?? "", /云端模型重新处理/u);
}

test("ML Kit recognize failure keeps its call-site tag and first four stack lines in the notice", async () => {
  const error = new TypeError("[mlkit-recognize] undefined is not a function");
  error.stack = [
    "TypeError: undefined is not a function",
    "at recognizeWithMlKit (mlkit-ocr.ts:18:46)",
    "at perceiveScreenshotWithOcr (perceive-ocr.ts:120:28)",
    "at uploadScreenshot (api.ts:173:25)",
    "at omittedFrame (api.ts:174:1)",
  ].join("\n");
  const upload = await runOcrFallbackCase(async () => {
    throw error;
  });

  assert.equal(
    upload.processing_notice,
    "本地 OCR 运行失败，已用云端模型重新处理。 本地 OCR 未能运行：message=[mlkit-recognize] undefined is not a function；name=TypeError；stack=TypeError: undefined is not a function; at recognizeWithMlKit (mlkit-ocr.ts:18:46); at perceiveScreenshotWithOcr (perceive-ocr.ts:120:28); at uploadScreenshot (api.ts:173:25)",
  );
  assert.doesNotMatch(upload.processing_notice, /omittedFrame/u);
});

test("region sampler failure keeps its call-site tag in the notice", async () => {
  const error = new TypeError("[region-sampler] undefined is not a function");
  error.stack = [
    "TypeError: undefined is not a function",
    "at sampleWithNativeModule (mlkit-ocr.ts:54:25)",
  ].join("\n");
  const upload = await runOcrFallbackCase(async () => {
    throw error;
  });

  assert.match(upload.processing_notice ?? "", /\[region-sampler\]/u);
});

test("zero OCR lines fall back to Qwen-VL without crashing", async () => {
  const upload = await runOcrFallbackCase(async () => ({
    lines: [],
    warnings: [],
    degraded: false,
  }));

  assert.equal(
    upload.processing_notice,
    "本地 OCR 未识别到文本，已用云端模型重新处理。",
  );
});

test("all-null region samples stay on OCR text and do not create a Qwen-VL provider", async () => {
  const degradedOcr = await perceiveScreenshotWithOcr({
    uri: "file:///fake/fallback.png",
    async recognize() {
      return {
        blocks: [{
          lines: [
            { text: "左侧锚点", frame: { left: 24, top: 20, width: 100, height: 30 } },
            { text: "第一条满宽消息", frame: { left: 24, top: 80, width: 342, height: 30 } },
            { text: "第二条满宽消息", frame: { left: 24, top: 150, width: 342, height: 30 } },
            { text: "右侧锚点", frame: { left: 266, top: 240, width: 100, height: 30 } },
          ],
        }],
      };
    },
    async sampleRegions(requests) {
      return {
        samples: requests.map((request) => ({ id: request.id, side: null })),
      };
    },
  });

  assert.equal(degradedOcr.degraded, true);
  assert.equal(degradedOcr.hasUnresolvedMessageSpeakers, true);
  assert.equal(degradedOcr.warnings.length, 2);
  assert.ok(degradedOcr.lines.every((line, index) => index === 0 || index === 3 || line.side === null));

  await runOcrTextOnlyCase(degradedOcr);
});

test("recognized text without geometry stays on text perception and skips Qwen-VL", async () => {
  const ocr = await perceiveScreenshotWithOcr({
    uri: "file:///fake/no-geometry.png",
    async recognize() {
      return {
        blocks: [{ lines: [{ text: "8月26日上午9:30开会", confidence: 0.94 }] }],
      };
    },
    async sampleRegions() {
      throw new Error("lines without geometry must not be sampled");
    },
  });

  assert.equal(ocr.lines.length, 1);
  assert.deepEqual(
    ocr.lines[0],
    {
      text: "8月26日上午9:30开会",
      side: null,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      confidence: 0.94,
    },
  );
  await runOcrTextOnlyCase(ocr);
});

test("low-confidence OCR rows above the threshold fall back to Qwen-VL", async () => {
  const upload = await runOcrFallbackCase(async () => ({
    lines: [0.2, 0.3, 0.4, 0.95].map((confidence, index) => ({
      text: `第 ${index + 1} 行`,
      side: null,
      x: 24,
      y: 40 + index * 35,
      width: 120,
      height: 30,
      confidence,
    })),
    warnings: [],
    degraded: false,
  }));

  assert.equal(
    upload.processing_notice,
    "本地 OCR 识别结果置信度过低，已用云端模型重新处理。",
  );
});

test("OCR text interpretation failure falls back to Qwen-VL once", async () => {
  await runOcrFallbackCase(
    async () => ({
      lines: [{
        text: "下周二见",
        side: "them",
        x: 24,
        y: 80,
        width: 120,
        height: 30,
        confidence: 0.95,
      }],
      warnings: [],
      degraded: false,
    }),
    async () => {
      throw new Error("text model unavailable");
    },
    1,
  );
});

test("healthy OCR stays on the text path and does not create a Qwen-VL provider", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let textPerceptionCalls = 0;
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
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false };
    },
    async perceiveOcr() {
      return {
        lines: [{
          text: "下周二见",
          side: "them",
          x: 24,
          y: 80,
          width: 120,
          height: 30,
          confidence: 0.95,
        }],
        warnings: [],
        degraded: false,
      };
    },
    async perceiveOcrText() {
      textPerceptionCalls += 1;
      return emptyExtraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/healthy.png", mimeType: "image/png" },
  });

  assert.equal(textPerceptionCalls, 1);
  assert.equal(qwen.calls, 0);
  assert.equal(upload.processing_notice, undefined);
});

test("forced cloud path does not invoke OCR or OCR text interpretation", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let ocrCalls = 0;
  let textPerceptionCalls = 0;
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
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "cloud", exportOcrResults: true };
    },
    async perceiveOcr() {
      ocrCalls += 1;
      return { lines: [], warnings: [], degraded: false };
    },
    async perceiveOcrText() {
      textPerceptionCalls += 1;
      return emptyExtraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/cloud.png", mimeType: "image/png" },
  });

  assert.equal(qwen.calls, 1);
  assert.equal(ocrCalls, 0);
  assert.equal(textPerceptionCalls, 0);
  assert.equal(store.listMeetingCalls, 1);
  assert.equal(upload.processing_notice, undefined);
});

test("OCR export failure is reported without changing a healthy text result", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
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
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: true };
    },
    async perceiveOcr() {
      return {
        lines: [{
          text: "下周二见",
          side: "them",
          x: 24,
          y: 80,
          width: 120,
          height: 30,
          confidence: 0.95,
        }],
        warnings: [],
        degraded: false,
      };
    },
    async perceiveOcrText() {
      return emptyExtraction;
    },
    async exportOcr() {
      throw new Error("directory picker cancelled");
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/healthy.png", mimeType: "image/png" },
  });

  assert.equal(qwen.calls, 0);
  assert.match(upload.processing_notice ?? "", /OCR 原始结果没有导出/u);
  assert.ok(await api.getScreenshotDetail(upload.screenshot_id));
});

test("text upload proposes a linked meeting update for a high-confidence progress match", async () => {
  const store = new FakeLocalStore();
  const contact = store.createContact({ canonicalName: "荀导" });
  const meeting = store.insertMeeting({
    kind: "other",
    title: "项目碰头会",
    timeIso: null,
    timeText: "今天上午",
    participants: [{ contact_id: contact.id, name: "荀导" }],
    agenda: "等主创到场",
  });
  const extraction = {
    participants: [
      {
        name: "荀导",
        is_self: false,
        interaction_summary: "荀导已到",
        confidence: "high" as const,
        source_quote: "荀导已到",
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  } satisfies PerceptionResult;
  const text = new FakeStructuredOutputProvider(
    () => ({ insights: [] }),
    () => JSON.stringify({
      matches: [
        {
          fragment_id: 1,
          meeting_id: meeting.id,
          confidence: "high",
        },
      ],
    }),
  );
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async () => {
      throw new Error("image loading is not used for text uploads");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("Qwen is not used for text uploads");
      },
      async createTextProvider() {
        return text;
      },
    },
    async perceiveOcrText() {
      return extraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadText({ text: "荀导已到" });
  const meetingUpdate = upload.cards.find((card) => card.type === "create_meeting");
  const interaction = upload.cards.find((card) => card.type === "record_interaction");

  assert.ok(meetingUpdate);
  assert.equal(meetingUpdate.payload.duplicate_of_meeting_id, meeting.id);
  assert.equal(meetingUpdate.payload.agenda_append, "荀导已到");
  assert.ok(interaction);
  assert.equal(interaction.payload.contact_id, contact.id);
  assert.equal(store.listMeetingCalls, 1);
  assert.equal(text.completeCalls, 1);
});

test("medium meeting progress keeps the interaction card and confirmation persists its observation", async () => {
  const store = new FakeLocalStore();
  const contact = store.createContact({ canonicalName: "荀导" });
  const meeting = store.insertMeeting({
    kind: "other",
    title: "项目碰头会",
    timeIso: null,
    timeText: "今天上午",
    participants: [{ contact_id: contact.id, name: "荀导" }],
  });
  const extraction = {
    participants: [
      {
        name: "荀导",
        is_self: false,
        interaction_summary: "荀导已到",
        confidence: "high" as const,
        source_quote: "荀导已到",
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  } satisfies PerceptionResult;
  const text = new FakeStructuredOutputProvider(
    () => ({ insights: [] }),
    () => JSON.stringify({
      matches: [
        {
          fragment_id: 1,
          meeting_id: meeting.id,
          confidence: "medium",
        },
      ],
    }),
  );
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async () => {
      throw new Error("image loading is not used for text uploads");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("Qwen is not used for text uploads");
      },
      async createTextProvider() {
        return text;
      },
    },
    async perceiveOcrText() {
      return extraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadText({ text: "荀导已到" });
  const interaction = upload.cards.find((card) => card.type === "record_interaction");

  assert.equal(upload.cards.some((card) => card.type === "create_meeting"), false);
  assert.ok(interaction);
  assert.equal(text.completeCalls, 1);
  assert.equal(store.listMeetingCalls, 1);

  const confirmed = await api.confirmCard(interaction.id);
  const detail = await api.getContactDetail(contact.id);

  assert.equal(confirmed.observation_ids.length, 1);
  assert.ok(detail.observations.some((observation) =>
    observation.kind === "interaction" &&
    observation.screenshot_id === upload.screenshot_id &&
    observation.content.includes("荀导已到")));
  assert.equal(text.calls, 1);
  assert.equal(store.listMeetingCalls, 1);
});

test("confirmed same_as alias makes the next batch exact without calling the LLM provider", async () => {
  const store = new FakeLocalStore();
  const contact = store.createContact({ canonicalName: "王磊" });
  const extraction = {
    participants: [{
      name: "王总",
      is_self: false,
      confidence: "high" as const,
      source_quote: "王总，方案已经发你",
    }],
    events: [],
    facts: [],
    quotes: [],
  } satisfies PerceptionResult;
  const text = new FakeStructuredOutputProvider(() => ({
    decision: "same_as",
    contact_id: contact.id,
  }));
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async () => {
      throw new Error("image loading is not used for text uploads");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("Qwen is not used for text uploads");
      },
      async createTextProvider() {
        return text;
      },
    },
    async perceiveOcrText() {
      return extraction;
    },
    now: () => new Date(FIXED_NOW),
  });

  const firstUpload = await api.uploadText({ text: "王总，方案已经发你" });
  assert.equal(text.calls, 1);
  assert.equal(text.completeCalls, 0);
  assert.deepEqual(firstUpload.cards.map((card) => card.type), [
    "update_contact",
    "record_interaction",
  ]);
  const aliasCard = firstUpload.cards.find((card) => card.type === "update_contact");
  if (!aliasCard || aliasCard.type !== "update_contact") {
    throw new Error("expected update_contact card");
  }
  assert.deepEqual(aliasCard.payload.changes.aliases, { old: null, new: "王总" });

  await api.confirmCard(aliasCard.id);
  assert.deepEqual(store.getContactById(contact.id)?.aliases, ["王总"]);

  text.calls = 0;
  const secondUpload = await api.uploadText({ text: "王总，方案已经发你" });

  assert.equal(text.calls, 0);
  assert.equal(text.completeCalls, 0);
  assert.deepEqual(secondUpload.cards.map((card) => card.type), ["record_interaction"]);
});
