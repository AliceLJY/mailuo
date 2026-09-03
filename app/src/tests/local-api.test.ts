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
  createConnectionConfigStore,
  getLocalProcessingSettings,
  type TextStorage,
} from "../connection/config";
import {
  hydrateLocalBatchCardForResponse,
  LocalBatchContactMappingError,
  LocalBatchContactSession,
  preparePersistedLocalBatchConfirmation,
} from "../local/batch-contacts";
import { perceiveScreenshotWithOcr, type OcrPerceptionResult } from "../local/perceive-ocr";
import type { LocalStore } from "../local/types";
import type { LocalLlmSecretStore } from "../connection/secrets";
import type { DiagnosticsTrace } from "../diagnostics/trace-store";
import {
  configureEventLogStorage,
  readEventLog,
  type SyncEventLogStorage,
} from "../diagnostics/event-log";
import {
  writeDiagnosticsBundleToDirectory,
  type DiagnosticsExportDirectory,
} from "../diagnostics/diagnostics-export";

const FIXED_NOW = new Date("2026-08-27T04:00:00.000Z");

function createFakeExportDirectory(uri = "fake:///picked/"): DiagnosticsExportDirectory {
  const entries = new Set<string>();

  return {
    uri,
    list() {
      return [...entries].map((name) => ({ name }));
    },
    createDirectory(name) {
      if (entries.has(name)) {
        throw new Error(`entry already exists: ${name}`);
      }
      entries.add(name);
      return createFakeExportDirectory(`${uri}${name}/`);
    },
    createFile(name) {
      if (entries.has(name)) {
        throw new Error(`entry already exists: ${name}`);
      }
      entries.add(name);
      let content = "";
      return {
        uri: `${uri}${name}`,
        write(value) {
          content = value;
        },
        async text() {
          return content;
        },
      };
    },
  };
}

class FakeStructuredOutputProvider implements StructuredOutputProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls = 0;
  completeCalls = 0;
  readonly structuredOutputMessages: StructuredOutputRequest<unknown>["messages"][] = [];

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
    this.structuredOutputMessages.push(request.messages);
    return request.schema.parse(this.response());
  }
}

function getStructuredSystemPrompt(
  provider: FakeStructuredOutputProvider,
  callIndex = 0,
): string {
  const content = provider.structuredOutputMessages[callIndex]?.find(
    (message) => message.role === "system",
  )?.content;
  if (typeof content !== "string") {
    throw new Error(`structured output call ${callIndex} has no string system prompt`);
  }
  return content;
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
  diagnosticsSnapshotReads = 0;

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

  countPendingLocalBatchInteractionCards(anchorCardId: number): number {
    return [...this.cards.values()].filter((card) =>
      card.type === "record_interaction" &&
      card.status === "pending" &&
      card.disambiguation?.local_batch_deferred?.dependencies.some(
        (dependency) =>
          dependency.kind === "record_interaction" &&
          dependency.anchor_card_id === anchorCardId,
      ),
    ).length;
  }

  clearAllData(): void {
    this.insights.length = 0;
    this.observations.length = 0;
    this.meetings.length = 0;
    this.cards.clear();
    this.screenshots.clear();
    this.contacts.clear();
  }

  readDiagnosticsSnapshot() {
    this.diagnosticsSnapshotReads += 1;
    return {
      screenshots: [...this.screenshots.values()],
      action_cards: [...this.cards.values()],
      contacts: [...this.contacts.values()],
      observations: [...this.observations],
      meetings: [...this.meetings],
      insights: [...this.insights],
    };
  }

  tableCounts() {
    return {
      insights: this.insights.length,
      observations: this.observations.length,
      meetings: this.meetings.length,
      action_cards: this.cards.size,
      screenshots: this.screenshots.size,
      contacts: this.contacts.size,
    };
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
    const content = input.content.trim();

    if (!content) {
      throw new TypeError("Observation content must be a non-empty string");
    }

    const screenshotId = input.screenshotId ?? null;
    const sourceQuote = input.sourceQuote?.trim() || null;
    const dedupeByContent = input.kind === "fact" || input.kind === "preference";
    const existing = this.observations.find(
      (item) =>
        item.contact_id === input.contactId &&
        item.kind === input.kind &&
        item.content === content &&
        (
          dedupeByContent ||
          (item.screenshot_id === screenshotId && item.source_quote === sourceQuote)
        ),
    );

    if (existing) {
      if (
        dedupeByContent &&
        sourceQuote &&
        (existing.source_quote == null || sourceQuote.length < existing.source_quote.length)
      ) {
        existing.source_quote = sourceQuote;
      }

      return existing;
    }

    const observation: ObservationRecord = {
      id: ++this.observationId,
      contact_id: input.contactId,
      screenshot_id: screenshotId,
      kind: input.kind,
      content,
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

  replaceInsightsForContacts(
    entries: Parameters<LocalStore["replaceInsightsForContacts"]>[0],
  ) {
    const contactIds = new Set(entries.map((entry) => entry.contact_id));

    for (let index = this.insights.length - 1; index >= 0; index -= 1) {
      if (contactIds.has(this.insights[index]!.contact_id)) {
        this.insights.splice(index, 1);
      }
    }

    return this.insertInsights(entries);
  }
}

test("FakeLocalStore mirrors content-based fact/preference deduplication and interaction provenance", () => {
  const store = new FakeLocalStore();
  const firstObservedAt = "2026-08-26T00:01:00.000Z";
  const firstFact = store.insertObservationIfAbsent({
    contactId: 1,
    screenshotId: 10,
    kind: "fact",
    content: "  公司: 某集团  ",
    sourceQuote: "王磊目前在某集团任职",
    observedAt: firstObservedAt,
  });
  const firstPreference = store.insertObservationIfAbsent({
    contactId: 1,
    screenshotId: 10,
    kind: "preference",
    content: "偏好线下沟通",
    sourceQuote: null,
    observedAt: firstObservedAt,
  });
  const shorterFact = store.insertObservationIfAbsent({
    contactId: 1,
    screenshotId: 11,
    kind: "fact",
    content: "公司: 某集团",
    sourceQuote: "某集团",
    observedAt: "2026-08-26T00:02:00.000Z",
  });
  const quotedPreference = store.insertObservationIfAbsent({
    contactId: 1,
    screenshotId: 11,
    kind: "preference",
    content: "偏好线下沟通",
    sourceQuote: "偏好线下沟通",
    observedAt: "2026-08-26T00:02:00.000Z",
  });
  const firstInteraction = store.insertObservationIfAbsent({
    contactId: 1,
    screenshotId: 10,
    kind: "interaction",
    content: "讨论合作",
    sourceQuote: "讨论合作",
    observedAt: firstObservedAt,
  });
  const secondInteraction = store.insertObservationIfAbsent({
    contactId: 1,
    screenshotId: 11,
    kind: "interaction",
    content: "讨论合作",
    sourceQuote: "讨论合作",
    observedAt: "2026-08-26T00:02:00.000Z",
  });

  assert.equal(shorterFact.id, firstFact.id);
  assert.equal(shorterFact.screenshot_id, 10);
  assert.equal(shorterFact.observed_at, firstObservedAt);
  assert.equal(shorterFact.source_quote, "某集团");
  assert.equal(quotedPreference.id, firstPreference.id);
  assert.equal(quotedPreference.screenshot_id, 10);
  assert.equal(quotedPreference.observed_at, firstObservedAt);
  assert.equal(quotedPreference.source_quote, "偏好线下沟通");
  assert.notEqual(secondInteraction.id, firstInteraction.id);
});

test("clearAllData removes all six local data tables while retaining keys and settings", async () => {
  const store = new FakeLocalStore();
  const screenshot = store.createScreenshot({ imagePath: "file:///clear-all.png" });
  const [card] = store.saveScreenshotAnalysis({
    screenshotId: screenshot.id,
    rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
    cards: [{
      type: "create_contact",
      payload: { name: "保留前的联系人卡" },
      confidence: "high",
      source_quote: "测试清空",
    }],
  });
  assert.ok(card);
  const contact = store.createContact({ canonicalName: "王总" });
  const observation = store.insertObservationIfAbsent({
    contactId: contact.id,
    screenshotId: screenshot.id,
    kind: "fact",
    content: "一条事实",
  });
  store.insertMeeting({
    kind: "meeting",
    title: "测试会议",
    timeIso: null,
    timeText: "待定",
    participants: [{ contact_id: contact.id, name: "王总" }],
    sourceScreenshotId: screenshot.id,
  });
  store.insertInsights([{
    contact_id: contact.id,
    kind: "relationship_read",
    content: "一条洞察",
    based_on: [observation.id],
    generated_at: FIXED_NOW.toISOString(),
  }]);

  const retainedSecrets = new Map([["DASHSCOPE_API_KEY", "retained-key"]]);
  let secretClearCalls = 0;
  const retainedKeys: LocalLlmSecretStore = {
    async get(name) {
      return retainedSecrets.get(name) ?? null;
    },
    async set(name, value) {
      retainedSecrets.set(name, value);
    },
    async clear(name) {
      secretClearCalls += 1;
      retainedSecrets.delete(name);
    },
    async clearAll() {
      secretClearCalls += 1;
      retainedSecrets.clear();
    },
  };
  let storedConfig: string | null = null;
  let configRemoveCalls = 0;
  const configStorage: TextStorage = {
    async getItem() {
      return storedConfig;
    },
    async setItem(_key, value) {
      storedConfig = value;
    },
    async removeItem() {
      configRemoveCalls += 1;
      storedConfig = null;
    },
  };
  const retainedConfigStore = createConnectionConfigStore(configStorage);
  await retainedConfigStore.set({
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
    selfNames: ["小禾"],
  });
  const api = createLocalApi({
    store,
    keys: retainedKeys,
    async loadImage() {
      throw new Error("clearAllData must not load an image");
    },
    async getProcessingSettings() {
      return getLocalProcessingSettings(await retainedConfigStore.get());
    },
  });

  assert.deepEqual(store.tableCounts(), {
    insights: 1,
    observations: 1,
    meetings: 1,
    action_cards: 1,
    screenshots: 1,
    contacts: 1,
  });

  await api.clearAllData();

  assert.deepEqual(store.tableCounts(), {
    insights: 0,
    observations: 0,
    meetings: 0,
    action_cards: 0,
    screenshots: 0,
    contacts: 0,
  });
  await assert.rejects(api.confirmCard(card.id), /Action card .* not found/u);
  await assert.rejects(api.getScreenshotDetail(screenshot.id), /Screenshot .* not found/u);
  assert.equal(await retainedKeys.get("DASHSCOPE_API_KEY"), "retained-key");
  assert.equal(secretClearCalls, 0);
  assert.deepEqual(await retainedConfigStore.get(), {
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
    selfNames: ["小禾"],
  });
  assert.equal(configRemoveCalls, 0);
});

const fakeKeys: LocalLlmSecretStore = {
  async get(name) {
    return name.endsWith("MODEL") ? null : "injected-test-value";
  },
  async set() {},
  async clear() {},
  async clearAll() {},
};

test("diagnostics export uses the live store snapshot and leaves the same store usable", async () => {
  const store = new FakeLocalStore();
  const screenshot = store.createScreenshot({ imagePath: "file:///diagnostics.png" });
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    async loadImage() {
      throw new Error("diagnostics export must not load an image");
    },
  });

  const snapshot = await api.readDiagnosticsSnapshot();
  await writeDiagnosticsBundleToDirectory(createFakeExportDirectory(), {
    snapshot,
    traces: [],
    eventLog: [],
    appVersion: "3.1.6",
    platform: "android",
    connectionMode: "local",
    exportedAt: FIXED_NOW,
  });

  assert.equal(store.diagnosticsSnapshotReads, 1);
  assert.deepEqual(snapshot.screenshots, [screenshot]);
  assert.deepEqual(await api.getScreenshotDetail(screenshot.id), {
    ...screenshot,
    cards: [],
  });
});

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

function eventExtraction(
  events: PerceptionResult["events"],
): PerceptionResult {
  return {
    participants: [],
    events,
    facts: [],
    quotes: [],
  };
}

function createBatchEventHarness(extractions: PerceptionResult[]) {
  const store = new FakeLocalStore();
  const pendingExtractions = [...extractions];
  const qwen = new FakeStructuredOutputProvider(() => {
    const extraction = pendingExtractions.shift();
    if (!extraction) {
      throw new Error("unexpected perception call");
    }
    return extraction;
  });
  const text = new FakeStructuredOutputProvider(
    () => ({ insights: [] }),
    () => JSON.stringify({ matches: [] }),
  );
  const traces: DiagnosticsTrace[] = [];
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
    traceWriter(trace) {
      traces.push(trace);
    },
    now: () => new Date(FIXED_NOW),
  });

  return { createApi, store, traces };
}

const damagedVehicleNotice =
  "@小禾你和邬导联系一下,给他报损备明天上午过来集团开会的车牌号。中午给他打一份工作餐。";
const correctedVehicleNotice =
  "@小禾你和邬导联系一下,给他报备明天上午过来集团开会的车牌号。中午给他打一份工作餐。";

function vehicleOtherExtraction(sourceQuote: string, title: string): PerceptionResult {
  return eventExtraction([{
    kind: "other",
    title,
    time_text: "明天 上午",
    time_iso: null,
    has_time_signal: true,
    participant_names: ["小禾", "邬导"],
    confidence: "high",
    source_quote: sourceQuote,
  }]);
}

test("local batch suppresses the second OCR-variant other item and records its trace match", async () => {
  const harness = createBatchEventHarness([
    vehicleOtherExtraction(damagedVehicleNotice, "报损备车及安排工作餐"),
    vehicleOtherExtraction(correctedVehicleNotice, "报备邬导车辆信息及安排工作餐"),
  ]);
  const api = harness.createApi();
  const session = new LocalBatchContactSession();
  const first = await api.uploadScreenshot({
    asset: { uri: "file:///fake/vehicle-1.png", mimeType: "image/png" },
    localBatch: { session, index: 0 },
  });
  const firstOther = first.cards.find((card) =>
    card.type === "create_meeting" && card.payload.kind === "other");
  assert.ok(firstOther);

  const second = await api.uploadScreenshot({
    asset: { uri: "file:///fake/vehicle-2.png", mimeType: "image/png" },
    localBatch: { session, index: 1 },
  });

  assert.equal(
    second.cards.some((card) =>
      card.type === "create_meeting" && card.payload.agenda_append != null),
    false,
  );
  assert.deepEqual(second.cards, []);
  assert.equal(session.listBatchOtherCards().length, 1);
  assert.deepEqual(harness.traces[1]?.batch_other_dedup?.map((match) => ({
    title: match.title,
    matched_card_id: match.matched_card_id,
  })), [{
    title: "报备邬导车辆信息及安排工作餐",
    matched_card_id: firstOther.id,
  }]);
  assert.ok(Math.abs(
    (harness.traces[1]?.batch_other_dedup?.[0]?.similarity ?? 0) -
      0.9743589743589743,
  ) < Number.EPSILON);
});

test("identical other items in separate local batch sessions are both proposed", async () => {
  const harness = createBatchEventHarness([
    vehicleOtherExtraction(correctedVehicleNotice, "报备邬导车辆信息及安排工作餐"),
    vehicleOtherExtraction(correctedVehicleNotice, "报备邬导车辆信息及安排工作餐"),
  ]);
  const api = harness.createApi();
  const first = await api.uploadScreenshot({
    asset: { uri: "file:///fake/batch-a.png", mimeType: "image/png" },
    localBatch: { session: new LocalBatchContactSession(), index: 0 },
  });
  const second = await api.uploadScreenshot({
    asset: { uri: "file:///fake/batch-b.png", mimeType: "image/png" },
    localBatch: { session: new LocalBatchContactSession(), index: 0 },
  });

  assert.equal(first.cards.length, 1);
  assert.equal(second.cards.length, 1);
  assert.equal(harness.traces[1]?.batch_other_dedup, undefined);
});

test("a rejected local-batch other item remains a dedup tombstone after API recreation", async () => {
  const harness = createBatchEventHarness([
    vehicleOtherExtraction(damagedVehicleNotice, "报损备车及安排工作餐"),
    vehicleOtherExtraction(correctedVehicleNotice, "报备邬导车辆信息及安排工作餐"),
  ]);
  const session = new LocalBatchContactSession();
  const firstApi = harness.createApi();
  const first = await firstApi.uploadScreenshot({
    asset: { uri: "file:///fake/rejected-vehicle-1.png", mimeType: "image/png" },
    localBatch: { session, index: 0 },
  });
  const firstOther = first.cards.find((card) =>
    card.type === "create_meeting" && card.payload.kind === "other");
  assert.ok(firstOther);

  const rebuiltApi = harness.createApi();
  const rejected = await rebuiltApi.rejectCard(firstOther.id);
  assert.equal(rejected.card.status, "rejected");
  const second = await rebuiltApi.uploadScreenshot({
    asset: { uri: "file:///fake/rejected-vehicle-2.png", mimeType: "image/png" },
    localBatch: { session, index: 1 },
  });

  assert.deepEqual(second.cards, []);
  assert.equal(session.listBatchOtherCards()[0]?.status, "rejected");
  assert.equal(
    harness.traces[1]?.batch_other_dedup?.[0]?.matched_card_id,
    firstOther.id,
  );
});

test("same-screenshot timeless notice routing writes the batch trace and black-box event", async () => {
  const meetingTitle = "海棠剧场舞台项目碰头会";
  const noticeTitle = "通知海棠塔和邬导会议时间变更";
  const noticeSource = "你们通知海棠塔和邬导这个时间。";
  const harness = createBatchEventHarness([eventExtraction([
    {
      kind: "meeting",
      title: meetingTitle,
      time_text: "明天下午",
      time_iso: null,
      has_time_signal: true,
      participant_names: ["小禾", "邬导", "海棠塔"],
      agenda: "确认舞台方案",
      confidence: "high",
      source_quote: "明天下午开海棠剧场舞台项目碰头会。",
    },
    {
      kind: "other",
      title: noticeTitle,
      time_text: "",
      time_iso: null,
      has_time_signal: false,
      participant_names: ["邬导", "海棠塔"],
      confidence: "high",
      source_quote: noticeSource,
    },
  ])]);
  const values = new Map<string, string>();
  const eventStorage: SyncEventLogStorage = {
    getItemSync(key) {
      return values.get(key) ?? null;
    },
    setItemSync(key, value) {
      values.set(key, value);
    },
  };
  configureEventLogStorage(eventStorage);

  try {
    const upload = await harness.createApi().uploadScreenshot({
      asset: { uri: "file:///fake/same-shot-notice.png", mimeType: "image/png" },
      localBatch: { session: new LocalBatchContactSession(), index: 0 },
    });
    const meeting = upload.cards.find((card) => card.type === "create_meeting");
    assert.ok(meeting);
    assert.equal(meeting.payload.agenda, `确认舞台方案；${noticeSource}`);
    assert.deepEqual(harness.traces[0]?.notice_routing, [{
      title: noticeTitle,
      decision: "batch",
      target_title: meetingTitle,
    }]);
    assert.deepEqual(
      readEventLog(eventStorage).filter((entry) => entry.kind === "notice_routed")
        .map((entry) => ({ kind: entry.kind, detail: entry.detail })),
      [{
        kind: "notice_routed",
        detail: `decision=batch title=${noticeTitle}`,
      }],
    );
  } finally {
    configureEventLogStorage(null);
  }
});

test("pasted-text notice routing also writes the black-box event", async () => {
  const meetingTitle = "青松展厅灯光项目碰头会";
  const noticeTitle = "通知骆导会议时间变更";
  const noticeSource = "请通知骆导这个时间。";
  const extraction = eventExtraction([
    {
      kind: "meeting",
      title: meetingTitle,
      time_text: "明天下午",
      time_iso: null,
      has_time_signal: true,
      participant_names: ["骆导"],
      agenda: "确认灯光方案",
      confidence: "high",
      source_quote: "明天下午开青松展厅灯光项目碰头会。",
    },
    {
      kind: "other",
      title: noticeTitle,
      time_text: "",
      time_iso: null,
      has_time_signal: false,
      participant_names: ["骆导"],
      confidence: "high",
      source_quote: noticeSource,
    },
  ]);
  const values = new Map<string, string>();
  const eventStorage: SyncEventLogStorage = {
    getItemSync(key) {
      return values.get(key) ?? null;
    },
    setItemSync(key, value) {
      values.set(key, value);
    },
  };
  configureEventLogStorage(eventStorage);

  try {
    const store = new FakeLocalStore();
    const text = new FakeStructuredOutputProvider(() => ({ insights: [] }));
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
          return text;
        },
      },
      async perceiveOcrText() {
        return extraction;
      },
      now: () => new Date(FIXED_NOW),
    });

    const upload = await api.uploadText({ text: "明天下午开灯光项目碰头会，请通知骆导。" });
    const meeting = upload.cards.find((card) => card.type === "create_meeting");
    assert.ok(meeting);
    assert.equal(meeting.payload.agenda, `确认灯光方案；${noticeSource}`);
    assert.deepEqual(
      readEventLog(eventStorage).filter((entry) => entry.kind === "notice_routed")
        .map((entry) => ({ kind: entry.kind, detail: entry.detail })),
      [{
        kind: "notice_routed",
        detail: `decision=batch title=${noticeTitle}`,
      }],
    );
  } finally {
    configureEventLogStorage(null);
  }
});

test("a timeless notice cannot match a pending meeting from an earlier screenshot", async () => {
  const meetingTitle = "梧桐展厅布展碰头会";
  const noticeTitle = "通知邬导会议时间变更";
  const harness = createBatchEventHarness([
    eventExtraction([{
      kind: "meeting",
      title: meetingTitle,
      time_text: "明天下午",
      time_iso: null,
      has_time_signal: true,
      participant_names: ["邬导"],
      confidence: "high",
      source_quote: "明天下午开梧桐展厅布展碰头会。",
    }]),
    eventExtraction([{
      kind: "other",
      title: noticeTitle,
      time_text: "",
      time_iso: null,
      has_time_signal: false,
      participant_names: ["邬导"],
      confidence: "high",
      source_quote: "请通知邬导这个时间。",
    }]),
  ]);
  const api = harness.createApi();
  const session = new LocalBatchContactSession();
  const first = await api.uploadScreenshot({
    asset: { uri: "file:///fake/meeting-shot.png", mimeType: "image/png" },
    localBatch: { session, index: 0 },
  });
  const second = await api.uploadScreenshot({
    asset: { uri: "file:///fake/notice-shot.png", mimeType: "image/png" },
    localBatch: { session, index: 1 },
  });

  assert.deepEqual(
    first.cards.map((card) => card.type === "create_meeting" ? card.payload.title : null),
    [meetingTitle],
  );
  assert.deepEqual(second.cards, []);
  assert.deepEqual(harness.traces[1]?.notice_routing, [{
    title: noticeTitle,
    decision: "dropped",
  }]);
});

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

test("a selected pending participant candidate maps to the confirmed anchor contact", async () => {
  const store = new FakeLocalStore();
  const extractions = [
    {
      participants: [{
        name: "荀导",
        is_self: false,
        interaction_summary: "沟通舞台方案",
        confidence: "high" as const,
        source_quote: "荀导负责舞台方案",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    {
      participants: [{
        name: "荀到",
        is_self: false,
        interaction_summary: "继续跟进舞台方案",
        confidence: "medium" as const,
        source_quote: "事项由荀到继续跟进",
      }],
      events: [{
        kind: "other" as const,
        title: "跟进舞台方案",
        time_text: "",
        time_iso: null,
        has_time_signal: false,
        participant_names: ["荀到"],
        confidence: "medium" as const,
        source_quote: "事项由荀到继续跟进",
      }],
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
  const text = new FakeStructuredOutputProvider(() => ({ decision: "new" }));
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
    now: () => new Date(FIXED_NOW),
  });
  const session = new LocalBatchContactSession();

  const first = await api.uploadScreenshot({
    asset: { uri: "file:///fake/liu-dao.png", mimeType: "image/png" },
    localBatch: { session, index: 0 },
  });
  const anchor = first.cards.find((card) =>
    card.type === "create_contact" && card.payload.name === "荀导");
  assert.ok(anchor);

  const second = await api.uploadScreenshot({
    asset: { uri: "file:///fake/liu-dao-ocr.png", mimeType: "image/png" },
    localBatch: { session, index: 1 },
  });
  const meeting = second.cards.find((card) => card.type === "create_meeting");
  assert.ok(meeting);
  if (meeting.type !== "create_meeting") {
    throw new Error("expected a create_meeting card");
  }
  const candidateId = meeting.payload.participants[0]?.candidates?.[0]?.contact_id;
  assert.equal(candidateId, -anchor.id);
  assert.equal(meeting.payload.participants[0]?.contact_id, undefined);

  const storedMeeting = store.getStoredActionCardById(meeting.id) as ActionCardRecord | null;
  assert.equal(storedMeeting?.type, "create_meeting");
  if (storedMeeting?.type !== "create_meeting") {
    throw new Error("expected a stored create_meeting card");
  }
  assert.deepEqual(storedMeeting.payload.participants, [{ name: "荀到" }]);
  assert.deepEqual(storedMeeting.disambiguation?.local_batch_deferred?.dependencies, [
    {
      kind: "meeting_participant_candidate",
      anchor_card_id: anchor.id,
      participant_index: 0,
      candidate_index: 0,
      candidate: { name: "荀导", company: null },
    },
  ]);
  assert.ok(collectContactIds(storedMeeting).every((contactId) => contactId >= 0));
  const unselected = preparePersistedLocalBatchConfirmation({
    card: storedMeeting,
    payload: meeting.payload,
    getAnchorCard: () => ({ ...anchor, status: "rejected" }),
  });
  assert.deepEqual(
    (unselected.payload as typeof meeting.payload).participants,
    [{ name: "荀到" }],
  );

  const reloadedMeeting = (await api.getScreenshotDetail(second.screenshot_id)).cards
    .find((card) => card.id === meeting.id);
  assert.equal(
    reloadedMeeting?.type === "create_meeting"
      ? reloadedMeeting.payload.participants[0]?.candidates?.[0]?.contact_id
      : null,
    -anchor.id,
  );

  const selectedPayload = {
    ...meeting.payload,
    participants: meeting.payload.participants.map((participant, index) => {
      if (index !== 0) {
        return participant;
      }
      const { candidates: _candidates, ...selected } = participant;
      return { ...selected, contact_id: candidateId! };
    }),
  };
  await assert.rejects(
    api.confirmCard(meeting.id, { payload: selectedPayload }),
    (error: unknown) => {
      assert.ok(error instanceof LocalBatchContactMappingError);
      assert.equal(error.message, "请先确认『新建联系人 荀导』那张卡");
      return true;
    },
  );
  assert.throws(
    () => preparePersistedLocalBatchConfirmation({
      card: storedMeeting,
      payload: selectedPayload,
      getAnchorCard: () => ({ ...anchor, status: "rejected" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalBatchContactMappingError);
      assert.equal(
        error.message,
        "这张卡依赖的『新建联系人 荀导』已被跳过，请把这张也跳过，或先手动新建该联系人",
      );
      return true;
    },
  );

  const anchorResult = await api.confirmCard(anchor.id);
  const realContactId = anchorResult.card.resolved_contact_id;
  assert.ok(realContactId && realContactId > 0);
  const meetingResult = await api.confirmCard(meeting.id, { payload: selectedPayload });
  assert.equal(meetingResult.card.type, "create_meeting");
  if (meetingResult.card.type !== "create_meeting") {
    throw new Error("expected a confirmed create_meeting card");
  }
  assert.equal(meetingResult.card.payload.participants[0]?.contact_id, realContactId);
  assert.equal((await api.getMeetings())[0]?.participants[0]?.contact_id, realContactId);
});

test("local batch only merges aliases approved by update cards", () => {
  const session = new LocalBatchContactSession();
  const firstPlan = session.prepareScreenshot({
    screenshotId: 1,
    batchIndex: 0,
    extraction: {
      participants: [{
        name: "王磊",
        is_self: false,
        company: "某集团市场部",
        confidence: "high",
        source_quote: "王磊在某集团市场部",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "王磊",
      normalized_name: "王磊",
      status: "new",
      source: "empty_db",
    }],
    cards: [{
      type: "create_contact",
      payload: { name: "王磊", company: "某集团市场部" },
      confidence: "high",
      source_quote: "王磊在某集团市场部",
    }],
  });
  const anchor = {
    ...firstPlan.cards[0],
    id: 31,
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

  const filteredPlan = session.prepareScreenshot({
    screenshotId: 2,
    batchIndex: 1,
    extraction: {
      participants: [{
        name: "王磊",
        aliases: ["某集团市扬部 王磊"],
        is_self: false,
        confidence: "medium",
        source_quote: "某集团市扬部 王磊",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "王磊",
      normalized_name: "王磊",
      status: "same_as",
      contact_id: -1,
      source: "exact",
    }],
    cards: [],
  });
  assert.deepEqual(filteredPlan.pendingCardUpdates[0]?.payload.aliases, undefined);

  const acceptedPlan = session.prepareScreenshot({
    screenshotId: 3,
    batchIndex: 2,
    extraction: {
      participants: [{
        name: "王总",
        is_self: false,
        confidence: "medium",
        source_quote: "王总已确认",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "王总",
      normalized_name: "王总",
      status: "same_as",
      contact_id: -1,
      source: "llm",
    }],
    cards: [{
      type: "update_contact",
      payload: {
        contact_id: -1,
        contact_name: "王磊",
        changes: { aliases: { old: null, new: "王总" } },
      },
      confidence: "medium",
      source_quote: "王总已确认",
    }],
  });
  assert.deepEqual(acceptedPlan.pendingCardUpdates[0]?.payload.aliases, ["王总"]);
});

test("local batch preserves mixed participant candidate order", () => {
  const session = new LocalBatchContactSession();
  const firstPlan = session.prepareScreenshot({
    screenshotId: 1,
    batchIndex: 0,
    extraction: {
      participants: [{
        name: "荀导",
        is_self: false,
        confidence: "high",
        source_quote: "荀导负责舞台方案",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "荀导",
      normalized_name: "荀导",
      status: "new",
      source: "empty_db",
    }],
    cards: [{
      type: "create_contact",
      payload: { name: "荀导" },
      confidence: "high",
      source_quote: "荀导负责舞台方案",
    }],
  });
  const anchor = {
    ...firstPlan.cards[0],
    id: 41,
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
        name: "荀到",
        is_self: false,
        confidence: "medium",
        source_quote: "事项由荀到跟进",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    resolutions: [{
      participant_name: "荀到",
      normalized_name: "荀到",
      status: "unsure",
      candidate_ids: [-1, 99],
      source: "near_match",
    }],
    cards: [{
      type: "create_meeting",
      payload: {
        kind: "other",
        title: "跟进舞台方案",
        time_text: "",
        time_iso: null,
        participants: [{
          name: "荀到",
          candidates: [
            { contact_id: -1, name: "荀导" },
            { contact_id: 99, name: "荀道" },
          ],
        }],
      },
      confidence: "medium",
      source_quote: "事项由荀到跟进",
    }],
  });
  const preparedDisambiguation = secondPlan.cards[0]?.disambiguation as
    ActionCardRecord["disambiguation"];
  assert.deepEqual(
    preparedDisambiguation?.local_batch_deferred?.dependencies,
    [{
      kind: "meeting_participant_candidate",
      anchor_card_id: anchor.id,
      participant_index: 0,
      candidate_index: 0,
      candidate: { name: "荀导" },
    }],
  );
  const storedMeeting = {
    ...secondPlan.cards[0],
    id: 42,
    screenshot_id: 2,
    disambiguation: secondPlan.cards[0]?.disambiguation ?? null,
    status: "pending" as const,
    resolved_contact_id: null,
    created_at: FIXED_NOW.toISOString(),
    resolved_at: null,
  } as ActionCardRecord;
  const committed = session.commitScreenshot({
    plan: secondPlan,
    savedCards: [storedMeeting],
    updatedAnchorCards: new Map(),
  });
  const candidateIds = (card: ActionCardRecord | undefined) =>
    card?.type === "create_meeting"
      ? card.payload.participants[0]?.candidates?.map((candidate) => candidate.contact_id)
      : undefined;

  assert.deepEqual(candidateIds(committed.cards[0]), [-anchor.id, 99]);
  assert.deepEqual(
    candidateIds(hydrateLocalBatchCardForResponse(storedMeeting, () => anchor)),
    [-anchor.id, 99],
  );

  const mixedStoredMeeting = {
    ...storedMeeting,
    payload: {
      ...storedMeeting.payload,
      participants: [{
        name: "荀到",
        candidates: [
          { contact_id: 1, name: "荀老师" },
          { contact_id: 2, name: "荀主任" },
        ],
      }],
    },
    disambiguation: {
      candidates: [],
      local_batch_deferred: {
        version: 1 as const,
        dependencies: [
          {
            kind: "meeting_participant_candidate" as const,
            anchor_card_id: 51,
            participant_index: 0,
            candidate_index: 1,
            candidate: { name: "荀导甲" },
          },
          {
            kind: "meeting_participant_candidate" as const,
            anchor_card_id: 52,
            participant_index: 0,
            candidate_index: 2,
            candidate: { name: "荀导乙" },
          },
        ],
      },
    },
  } as ActionCardRecord;
  const mixedHydrated = hydrateLocalBatchCardForResponse(
    mixedStoredMeeting,
    (anchorCardId) => ({
      ...anchor,
      id: anchorCardId,
      status: anchorCardId === 51 ? "rejected" : "pending",
    }),
  );
  assert.deepEqual(candidateIds(mixedHydrated), [1, -52, 2]);

  const invalidIndexMeeting = {
    ...mixedStoredMeeting,
    disambiguation: {
      ...mixedStoredMeeting.disambiguation,
      local_batch_deferred: {
        version: 1,
        dependencies: [{
          ...mixedStoredMeeting.disambiguation!.local_batch_deferred!.dependencies[0],
          candidate_index: "bad",
        }],
      },
    },
  } as unknown as ActionCardRecord;
  assert.throws(
    () => hydrateLocalBatchCardForResponse(invalidIndexMeeting, () => anchor),
    /invalid meeting participant candidate index/u,
  );
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

test("a persisted dependent interaction reports its named pending, rejected, and missing anchor", async () => {
  const store = new FakeLocalStore();
  const extractions: PerceptionResult[] = [
    {
      participants: [{
        name: "王总",
        is_self: false,
        confidence: "high",
        source_quote: "王总：你好",
      }],
      events: [],
      facts: [],
      quotes: [],
    },
    {
      participants: [{
        name: "王总",
        is_self: false,
        interaction_summary: "讨论了下一步合作",
        confidence: "high",
        source_quote: "王总：下一步我们继续合作",
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
    now: () => new Date(FIXED_NOW),
  });
  const session = new LocalBatchContactSession();
  const anchorUpload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/wang-anchor-1.png", mimeType: "image/png" },
    localBatch: { session, index: 0 },
  });
  const anchor = anchorUpload.cards.find((card) => card.type === "create_contact");
  assert.ok(anchor);
  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/wang-anchor-2.png", mimeType: "image/png" },
    localBatch: { session, index: 1 },
  });
  const interaction = upload.cards.find((card) => card.type === "record_interaction");
  assert.ok(interaction);
  assert.deepEqual(interaction.disambiguation?.local_batch_anchor, {
    anchor_card_id: anchor.id,
    name: "王总",
    status: "pending",
  });
  assert.equal(await api.countPendingLocalBatchInteractionCards(anchor.id), 1);

  await assert.rejects(api.confirmCard(interaction.id), (error: unknown) => {
    assert.ok(error instanceof LocalBatchContactMappingError);
    assert.equal(error.message, "请先确认『新建联系人 王总』那张卡");
    assert.equal(error.anchorCardId, anchor.id);
    assert.equal(error.anchorCardName, "王总");
    assert.equal(error.anchorCardStatus, "pending");
    return true;
  });

  await api.rejectCard(anchor.id);
  const detailAfterReject = await api.getScreenshotDetail(upload.screenshot_id);
  const rejectedInteraction = detailAfterReject.cards.find((card) => card.id === interaction.id);
  assert.deepEqual(rejectedInteraction?.disambiguation?.local_batch_anchor, {
    anchor_card_id: anchor.id,
    name: "王总",
    status: "rejected",
  });
  await assert.rejects(api.confirmCard(interaction.id), (error: unknown) => {
    assert.ok(error instanceof LocalBatchContactMappingError);
    assert.equal(
      error.message,
      "这张互动依赖的『新建联系人 王总』已被跳过，请把这张也跳过，或先手动新建该联系人",
    );
    assert.equal(error.anchorCardId, anchor.id);
    assert.equal(error.anchorCardName, "王总");
    assert.equal(error.anchorCardStatus, "rejected");
    return true;
  });

  assert.throws(
    () => preparePersistedLocalBatchConfirmation({
      card: interaction,
      payload: interaction.payload,
      getAnchorCard: () => null,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalBatchContactMappingError);
      assert.equal(
        error.message,
        "这张互动依赖的新建联系人卡片已不存在，请跳过这张",
      );
      assert.equal(error.anchorCardStatus, "missing");
      return true;
    },
  );
});

test("configured self name overrides visual extraction and displays the meeting participant as me", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => ({
    participants: [{
      name: "麦  老师",
      is_self: false,
      role: "speaker",
      speech_act: "initiate",
      interaction_summary: "禾老师发起了周会安排。",
      confidence: "high",
      source_quote: "禾老师：周五一起开周会",
    }, {
      name: "小禾",
      is_self: false,
      role: "speaker",
      speech_act: "respond",
      interaction_summary: "小禾确认了周会安排。",
      confidence: "high",
      source_quote: "小禾：好的",
    }],
    events: [{
      kind: "meeting",
      title: "项目周会",
      time_text: "周五上午十点",
      time_iso: "2026-08-28T10:00:00+08:00",
      has_time_signal: true,
      participant_names: ["麦 老师", "小禾"],
      confidence: "high",
      source_quote: "禾老师：周五上午十点一起开项目周会",
    }],
    facts: [],
    quotes: [],
  }));
  const text = new FakeStructuredOutputProvider(() => ({ insights: [] }));
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
      return {
        perceptionPath: "cloud",
        exportOcrResults: false,
        selfNames: ["麦 老师", "小禾"],
      };
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/self-name.png", mimeType: "image/png" },
  });

  assert.deepEqual(upload.cards.map((card) => card.type), ["create_meeting"]);
  const meeting = upload.cards[0];
  assert.equal(meeting?.type, "create_meeting");
  if (meeting?.type === "create_meeting") {
    assert.deepEqual(meeting.payload.participants, [{ name: "我" }]);
  }
  const detail = await api.getScreenshotDetail(upload.screenshot_id);
  assert.equal(detail.raw_extraction?.participants[0]?.is_self, true);
});

test("a participant not matching configured self names keeps normal contact and interaction cards", async () => {
  const store = new FakeLocalStore();
  const extraction = {
    participants: [{
      name: "小杉",
      is_self: false,
      role: "speaker",
      speech_act: "initiate",
      interaction_summary: "小杉发起了方案讨论。",
      confidence: "high" as const,
      source_quote: "小杉：我们讨论一下新方案",
    }],
    events: [],
    facts: [],
    quotes: [],
  } satisfies PerceptionResult;
  const text = new FakeStructuredOutputProvider(() => ({ insights: [] }));
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
    async getProcessingSettings() {
      return { perceptionPath: "cloud", exportOcrResults: false, selfNames: ["小禾"] };
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadText({ text: "小杉：我们讨论一下新方案" });

  assert.deepEqual(
    upload.cards.map((card) => card.type),
    ["create_contact", "record_interaction"],
  );
  const detail = await api.getScreenshotDetail(upload.screenshot_id);
  assert.equal(detail.raw_extraction?.participants[0]?.is_self, false);
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
  assert.equal(detail.insights.length, 1);

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
  inspectVisualPrompt?: (prompt: string) => void,
) {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let imageLoads = 0;
  let textPerceptionCalls = 0;
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async (asset) => {
      imageLoads += 1;
      return {
        image: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
        imagePath: asset.uri,
      };
    },
    providers: {
      async createQwenProvider() {
        return qwen;
      },
      async createTextProvider() {
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] };
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
  assert.equal(imageLoads, 1);
  assert.equal(textPerceptionCalls, expectedTextPerceptionCalls);
  assert.match(upload.processing_notice ?? "", /已用云端模型重新处理/u);
  assert.ok(await api.getScreenshotDetail(upload.screenshot_id));
  inspectVisualPrompt?.(getStructuredSystemPrompt(qwen));

  return upload;
}

async function runOcrTextOnlyCase(ocr: OcrPerceptionResult) {
  const store = new FakeLocalStore();
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let imageLoads = 0;
  let qwenProviderCreations = 0;
  let textPerceptionCalls = 0;
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async (asset) => {
      imageLoads += 1;
      return {
        image: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
        imagePath: asset.uri,
      };
    },
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
      return { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] };
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
  assert.equal(imageLoads, 0);
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
  const upload = await runOcrFallbackCase(
    async () => {
      throw error;
    },
    undefined,
    0,
    (prompt) => {
      assert.doesNotMatch(prompt, /Local OCR detected these WeChat timestamp separators/u);
    },
  );

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
  const upload = await runOcrFallbackCase(
    async () => ({
      lines: [],
      warnings: [],
      degraded: false,
    }),
    undefined,
    0,
    (prompt) => {
      assert.doesNotMatch(prompt, /Local OCR detected these WeChat timestamp separators/u);
    },
  );

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
  const upload = await runOcrFallbackCase(
    async () => ({
      lines: [
        {
          text: "8月10日07:00",
          side: null,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          confidence: 0.2,
        },
        {
          text: "8月12日11:30",
          side: null,
          x: 300,
          y: 100,
          width: 120,
          height: 30,
          confidence: 0.2,
        },
        {
          text: "昨天 09:30",
          side: null,
          x: 180,
          y: 60,
          width: 120,
          height: 30,
          confidence: 0.3,
        },
        {
          text: " 8月11日08:59 ",
          side: null,
          x: 100,
          y: 100,
          width: 120,
          height: 30,
          confidence: 0.4,
        },
        {
          text: "今天下午14:30左右",
          side: "them",
          x: 24,
          y: 150,
          width: 180,
          height: 30,
          confidence: 0.95,
        },
      ],
      warnings: [],
      degraded: false,
    }),
    undefined,
    0,
    (prompt) => {
      assert.match(
        prompt,
        /Local OCR detected these WeChat timestamp separators in top-to-bottom order: 8月11日08:59 -> 8月12日11:30\./u,
      );
      assert.doesNotMatch(prompt, /昨天 09:30 ->/u);
      assert.doesNotMatch(prompt, /8月10日07:00/u);
    },
  );

  assert.equal(
    upload.processing_notice,
    "本地 OCR 识别结果置信度过低，已用云端模型重新处理。",
  );
});

test("OCR text interpretation failure falls back to Qwen-VL once", async () => {
  await runOcrFallbackCase(
    async () => ({
      lines: [
        {
          text: "8月12日11:30",
          side: null,
          x: 180,
          y: 40,
          width: 120,
          height: 30,
          confidence: 0.99,
        },
        {
          text: "今天下午14:30左右",
          side: "them",
          x: 24,
          y: 80,
          width: 180,
          height: 30,
          confidence: 0.95,
        },
      ],
      warnings: [],
      degraded: false,
    }),
    async () => {
      throw new Error("text model unavailable");
    },
    1,
    (prompt) => {
      assert.match(
        prompt,
        /Local OCR detected these WeChat timestamp separators in top-to-bottom order: 8月12日11:30\./u,
      );
    },
  );
});

test("healthy OCR stays on the text path and does not create a Qwen-VL provider", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  let imageLoads = 0;
  let textPerceptionCalls = 0;
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async (asset) => {
      imageLoads += 1;
      return {
        image: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
        imagePath: asset.uri,
      };
    },
    providers: {
      async createQwenProvider() {
        return qwen;
      },
      async createTextProvider() {
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] };
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
  assert.equal(imageLoads, 0);
  assert.equal(qwen.calls, 0);
  assert.equal(upload.processing_notice, undefined);
});

test("forced cloud path does not invoke OCR or OCR text interpretation", async () => {
  const store = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const text = new FakeStructuredOutputProvider(() => emptyExtraction);
  const traces: DiagnosticsTrace[] = [];
  let imageLoads = 0;
  let ocrCalls = 0;
  let textPerceptionCalls = 0;
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async (asset) => {
      imageLoads += 1;
      return {
        image: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
        imagePath: asset.uri,
      };
    },
    providers: {
      async createQwenProvider() {
        return qwen;
      },
      async createTextProvider() {
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "cloud", exportOcrResults: true, selfNames: [] };
    },
    async perceiveOcr() {
      ocrCalls += 1;
      return { lines: [], warnings: [], degraded: false };
    },
    async perceiveOcrText() {
      textPerceptionCalls += 1;
      return emptyExtraction;
    },
    traceWriter(traceRecord) {
      traces.push(traceRecord);
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/cloud.png", mimeType: "image/png" },
  });

  assert.equal(qwen.calls, 1);
  assert.equal(imageLoads, 1);
  assert.equal(ocrCalls, 0);
  assert.equal(textPerceptionCalls, 0);
  assert.equal(store.listMeetingCalls, 1);
  assert.equal(upload.processing_notice, undefined);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.perception_path, "cloud");
  assert.equal(traces[0]?.ocr_text, undefined);
  assert.doesNotMatch(
    getStructuredSystemPrompt(qwen),
    /Local OCR detected these WeChat timestamp separators/u,
  );
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
      return { perceptionPath: "ocr", exportOcrResults: true, selfNames: [] };
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

test("local screenshot success records OCR decisions and proposed cards", async () => {
  const store = new FakeLocalStore();
  const existingMeeting = store.insertMeeting({
    kind: "meeting",
    title: "市场部周会",
    timeIso: "2026-09-03T09:00:00+08:00",
    timeText: "明天上午九点",
    participants: [],
    createdAt: "2026-09-01T01:00:00.000Z",
  });
  const traces: DiagnosticsTrace[] = [];
  const text = new FakeStructuredOutputProvider(() => ({ insights: [] }));
  const extraction: PerceptionResult = {
    participants: [{
      name: "王磊",
      is_self: false,
      role: "speaker",
      interaction_summary: "确认材料进度",
      confidence: "high",
      source_quote: "王磊：材料已经发出",
    }],
    events: [{
      kind: "meeting",
      title: "市场部周会",
      time_text: "明天上午九点",
      time_iso: "2026-09-03T09:00:00+08:00",
      has_time_signal: true,
      participant_names: ["王磊"],
      confidence: "high",
      source_quote: "明天上午九点开市场部周会",
    }],
    facts: [],
    quotes: [],
  };
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async () => {
      throw new Error("healthy OCR must not load the image");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("healthy OCR must not create Qwen");
      },
      async createTextProvider() {
        return text;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] };
    },
    async perceiveOcr() {
      return {
        lines: [{
          text: "王磊：材料已经发出",
          side: "them",
          x: 20,
          y: 40,
          width: 180,
          height: 30,
          confidence: 0.98,
        }],
        warnings: [],
        degraded: false,
      };
    },
    async perceiveOcrText() {
      return extraction;
    },
    traceWriter(traceRecord) {
      traces.push(traceRecord);
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await api.uploadScreenshot({
    asset: { uri: "file:///fake/trace-success.png", mimeType: "image/png" },
  });

  assert.equal(upload.screenshot_id, 1);
  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0], {
    screenshot_id: 1,
    started_at: FIXED_NOW.toISOString(),
    finished_at: FIXED_NOW.toISOString(),
    perception_path: "ocr",
    ocr_text: "王磊：材料已经发出",
    extraction,
    resolutions: [{
      participant_name: "王磊",
      status: "new",
      source: "empty_db",
    }],
    proposed_cards: upload.cards.map((card) => ({
      type: card.type,
      payload: card.payload,
      disambiguation: card.disambiguation ?? null,
    })),
    meeting_dedup: [{
      title: "市场部周会",
      duplicate_of_meeting_id: existingMeeting.id,
    }],
    notices: [],
  });
});

test("local screenshot failure records OCR fallback state and preserves the original error", async () => {
  const store = new FakeLocalStore();
  const traces: DiagnosticsTrace[] = [];
  const processingError = new Error("视觉整理失败");
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async () => {
      throw processingError;
    },
    providers: {
      async createQwenProvider() {
        throw new Error("image loading fails first");
      },
      async createTextProvider() {
        return new FakeStructuredOutputProvider(() => emptyExtraction);
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] };
    },
    async perceiveOcr() {
      return {
        lines: [{
          text: "王磊：材料已经发出",
          side: "them",
          x: 20,
          y: 40,
          width: 180,
          height: 30,
          confidence: 0.98,
        }],
        warnings: [],
        degraded: false,
      };
    },
    async perceiveOcrText() {
      throw new Error("文字整理失败");
    },
    traceWriter(traceRecord) {
      traces.push(traceRecord);
    },
    now: () => new Date(FIXED_NOW),
  });

  await assert.rejects(
    api.uploadScreenshot({
      asset: { uri: "file:///fake/trace-failure.png", mimeType: "image/png" },
    }),
    (error) => {
      assert.strictEqual(error, processingError);
      return true;
    },
  );

  assert.equal(store.tableCounts().screenshots, 0);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.perception_path, "ocr->cloud");
  assert.equal(traces[0]?.ocr_text, "王磊：材料已经发出");
  assert.equal(traces[0]?.extraction, null);
  assert.deepEqual(traces[0]?.resolutions, []);
  assert.deepEqual(traces[0]?.proposed_cards, []);
  assert.match(traces[0]?.notices.join(" ") ?? "", /已用云端模型重新处理/u);
  assert.deepEqual(traces[0]?.error, {
    name: "Error",
    message: "视觉整理失败",
  });
});

test("OCR configuration is recorded before text-provider creation fails", async () => {
  const store = new FakeLocalStore();
  const traces: DiagnosticsTrace[] = [];
  const providerError = new Error("文字模型配置不可用");
  const api = createLocalApi({
    store,
    keys: fakeKeys,
    loadImage: async () => {
      throw new Error("image loading is not reached");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("Qwen is not reached");
      },
      async createTextProvider() {
        throw providerError;
      },
    },
    async getProcessingSettings() {
      return { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] };
    },
    async perceiveOcr() {
      throw new Error("OCR is not reached");
    },
    async perceiveOcrText() {
      throw new Error("OCR text is not reached");
    },
    traceWriter(traceRecord) {
      traces.push(traceRecord);
    },
    now: () => new Date(FIXED_NOW),
  });

  await assert.rejects(
    api.uploadScreenshot({
      asset: { uri: "file:///fake/provider-failure.png", mimeType: "image/png" },
    }),
    (error) => {
      assert.strictEqual(error, providerError);
      return true;
    },
  );

  assert.equal(store.tableCounts().screenshots, 0);
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.perception_path, "ocr");
  assert.equal(traces[0]?.extraction, null);
  assert.deepEqual(traces[0]?.error, {
    name: "Error",
    message: "文字模型配置不可用",
  });
});

test("trace writer failures never replace screenshot success or the original processing error", async () => {
  const successfulStore = new FakeLocalStore();
  const qwen = new FakeStructuredOutputProvider(() => emptyExtraction);
  const successfulApi = createLocalApi({
    store: successfulStore,
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
        return new FakeStructuredOutputProvider(() => emptyExtraction);
      },
    },
    traceWriter() {
      throw new Error("trace storage unavailable");
    },
    now: () => new Date(FIXED_NOW),
  });

  const upload = await successfulApi.uploadScreenshot({
    asset: { uri: "file:///fake/trace-writer-success.png", mimeType: "image/png" },
  });
  assert.equal(upload.screenshot_id, 1);
  assert.ok(await successfulApi.getScreenshotDetail(upload.screenshot_id));

  const failedStore = new FakeLocalStore();
  const providerError = new Error("模型配置不可用");
  const failedApi = createLocalApi({
    store: failedStore,
    keys: fakeKeys,
    loadImage: async () => {
      throw new Error("image loading is not reached");
    },
    providers: {
      async createQwenProvider() {
        throw new Error("Qwen is not reached");
      },
      async createTextProvider() {
        throw providerError;
      },
    },
    traceWriter() {
      throw new Error("trace storage unavailable");
    },
    now: () => new Date(FIXED_NOW),
  });

  await assert.rejects(
    failedApi.uploadScreenshot({
      asset: { uri: "file:///fake/trace-writer-failure.png", mimeType: "image/png" },
    }),
    (error) => {
      assert.strictEqual(error, providerError);
      return true;
    },
  );
  assert.equal(failedStore.tableCounts().screenshots, 0);
});
