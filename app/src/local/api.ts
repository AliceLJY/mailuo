import { executeCard, rejectCard as rejectActionCard } from "../../../shared/core/agent/execute.ts";
import { generateInsights } from "../../../shared/core/agent/insight.ts";
import {
  applySelfNames,
  perceiveScreenshot,
} from "../../../shared/core/agent/perceive.ts";
import type { PerceptionResult } from "../../../shared/core/agent/perceive.ts";
import { proposeCards } from "../../../shared/core/agent/propose.ts";
import {
  resolveMeetingProgress,
  resolveParticipants,
  type ResolvableContact,
} from "../../../shared/core/agent/resolve.ts";
import type { LocalLlmSecretStore } from "../connection/secrets";
import type { LocalProcessingSettings } from "../connection/config";
import type {
  ActionCardRecord,
  LocalBatchContactMerge,
  UploadImageAsset,
} from "../types";
import type { RoutedApi } from "../connection/dispatch";
import {
  writeConfiguredDiagnosticsTrace,
  type DiagnosticsTrace,
  type DiagnosticsTraceWriter,
} from "../diagnostics/trace-store";

import { createLocalProviderFactory, type LocalProviderFactory } from "./providers";
import {
  isOcrTextQualityPoor,
  isWechatAbsoluteTimeLine,
  type OcrPerceptionResult,
} from "./perceive-ocr";
import {
  createPastedTextOcrResult,
  createPastedTextSourceUri,
  perceiveOcrText as perceiveSharedOcrText,
} from "./perceive-text";
import {
  hydrateLocalBatchCardForResponse,
  preparePersistedLocalBatchConfirmation,
  type LocalBatchContactSession,
} from "./batch-contacts";
import type { LocalStore, ScreenshotImageLoader } from "./types";

const OCR_FALLBACK_NOTICE = "部分内容可能识别不全，已用云端模型重新处理。";
const OCR_RUNTIME_FALLBACK_NOTICE = "本地 OCR 运行失败，已用云端模型重新处理。";
const OCR_EMPTY_FALLBACK_NOTICE = "本地 OCR 未识别到文本，已用云端模型重新处理。";
const OCR_LOW_CONFIDENCE_FALLBACK_NOTICE =
  "本地 OCR 识别结果置信度过低，已用云端模型重新处理。";
const OCR_SPEAKER_NOTICE = "部分消息的发言人未能确定，已交由模型从文本判断。";
const OCR_EXPORT_FAILURE_NOTICE = "截图已处理，但 OCR 原始结果没有导出，请再试一次。";

export type OcrPerceiver = (uri: string) => Promise<OcrPerceptionResult>;

export type OcrTextPerceiver = (input: {
  ocr: OcrPerceptionResult;
  note?: string;
  provider: Awaited<ReturnType<LocalProviderFactory["createTextProvider"]>>;
  now: Date;
}) => Promise<PerceptionResult>;

export type OcrExporter = (input: {
  result: OcrPerceptionResult;
  asset: UploadImageAsset;
}) => Promise<void>;

export type CreateLocalApiOptions = {
  store: LocalStore;
  keys: LocalLlmSecretStore;
  loadImage: ScreenshotImageLoader;
  providers?: LocalProviderFactory;
  now?: () => Date;
  getProcessingSettings?: () => Promise<LocalProcessingSettings>;
  perceiveOcr?: OcrPerceiver;
  perceiveOcrText?: OcrTextPerceiver;
  exportOcr?: OcrExporter;
  traceWriter?: DiagnosticsTraceWriter;
};

function listResolvableContacts(store: LocalStore): ResolvableContact[] {
  return store.listContacts().map(
    ({ observation_count: _observationCount, last_interaction_at: _lastInteractionAt, ...contact }) =>
      contact,
  );
}

function notFound(entity: string, id: number): Error {
  return new Error(`${entity} ${id} not found`);
}

function formatOcrRuntimeFailureNotice(error: unknown): string {
  if (error instanceof Error) {
    const stackFirstFourLines = error.stack?.split(/\r?\n/u).slice(0, 4).join("; ") ?? "";
    return `本地 OCR 未能运行：message=${error.message}；name=${error.name}；stack=${stackFirstFourLines}`;
  }

  return `本地 OCR 未能运行：message=${String(error)}；name=${typeof error}；stack=`;
}

function collectOcrTimestampHints(ocr: OcrPerceptionResult): string[] {
  return ocr.lines
    .filter((line) => (
      [line.x, line.y, line.width, line.height].every(Number.isFinite) &&
      line.width > 0 &&
      line.height > 0 &&
      isWechatAbsoluteTimeLine(line.text)
    ))
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((line) => line.text.trim());
}

export function createLocalApi(options: CreateLocalApiOptions): RoutedApi {
  const providerFactory = options.providers ?? createLocalProviderFactory();
  const now = options.now ?? (() => new Date());
  const traceWriter = options.traceWriter ?? writeConfiguredDiagnosticsTrace;
  const getProcessingSettings = options.getProcessingSettings ?? (async () => ({
    perceptionPath: "cloud" as const,
    exportOcrResults: false,
    selfNames: [],
  }));
  const batchSessionByCardId = new Map<number, LocalBatchContactSession>();

  async function writeTraceBestEffort(
    trace: Omit<DiagnosticsTrace, "finished_at">,
  ): Promise<void> {
    try {
      await traceWriter({
        ...trace,
        finished_at: now().toISOString(),
      });
    } catch {
      // Diagnostics must never replace a successful upload or its original error.
    }
  }

  return {
    async uploadText(input) {
      const text = input.text.trim();
      if (!text) {
        throw new Error("请先粘贴需要整理的聊天文本。");
      }

      const processing = await getProcessingSettings();
      const textProvider = await providerFactory.createTextProvider(options.keys);
      const note = input.note?.trim() || undefined;
      const timestamp = now();
      // The local image loader preserves this URI; defer it so healthy OCR never creates base64.
      const screenshot = options.store.createScreenshot({
        imagePath: createPastedTextSourceUri(text),
        userNote: note ?? null,
        uploadedAt: timestamp.toISOString(),
      });

      try {
        const extraction = applySelfNames(
          await (options.perceiveOcrText ?? perceiveSharedOcrText)({
            ocr: createPastedTextOcrResult(text),
            note,
            provider: textProvider,
            now: timestamp,
          }),
          processing.selfNames,
        );
        const contacts = listResolvableContacts(options.store);
        const resolutions = await resolveParticipants({
          extraction,
          contacts,
          provider: textProvider,
        });
        const existingMeetings = options.store.listMeetings();
        const meetingProgressResolutions = await resolveMeetingProgress({
          extraction,
          meetings: existingMeetings,
          provider: textProvider,
        });
        const cards = options.store.saveScreenshotAnalysis({
          screenshotId: screenshot.id,
          rawExtraction: extraction,
          cards: proposeCards(
            extraction,
            resolutions,
            contacts,
            timestamp,
            existingMeetings,
            meetingProgressResolutions,
          ),
          createdAt: timestamp.toISOString(),
        });

        return {
          screenshot_id: screenshot.id,
          cards,
        };
      } catch (error) {
        try {
          options.store.deleteScreenshotUploadArtifacts(screenshot.id);
        } catch {
          // Preserve the processing error; cleanup can be retried during a later storage repair.
        }

        throw error;
      }
    },
    async uploadScreenshot(input) {
      const batchSession = input.localBatch?.session;
      const note = input.note?.trim() || undefined;
      const timestamp = now();
      const screenshot = options.store.createScreenshot({
        imagePath: input.asset.uri,
        userNote: note ?? null,
        uploadedAt: timestamp.toISOString(),
      });
      let tracePerceptionPath: DiagnosticsTrace["perception_path"] = "cloud";
      let traceOcrText: string | undefined;
      let traceExtraction: DiagnosticsTrace["extraction"] = null;
      let traceResolutions: DiagnosticsTrace["resolutions"] = [];
      let traceProposedCards: DiagnosticsTrace["proposed_cards"] = [];
      let traceMeetingDedup: DiagnosticsTrace["meeting_dedup"] = [];
      const notices: string[] = [];

      const traceState = (): Omit<DiagnosticsTrace, "finished_at"> => ({
        screenshot_id: screenshot.id,
        started_at: timestamp.toISOString(),
        perception_path: tracePerceptionPath,
        ...(traceOcrText !== undefined ? { ocr_text: traceOcrText } : {}),
        extraction: traceExtraction,
        resolutions: traceResolutions,
        proposed_cards: traceProposedCards,
        meeting_dedup: traceMeetingDedup,
        notices: [...notices],
      });

      try {
        batchSession?.reconcilePendingContacts((cardId) =>
          options.store.getStoredActionCardById(cardId),
        );
        const processing = await getProcessingSettings();
        const canUseOcr =
          processing.perceptionPath === "ocr" &&
          Boolean(options.perceiveOcr) &&
          Boolean(options.perceiveOcrText);
        tracePerceptionPath = canUseOcr ? "ocr" : "cloud";
        const textProvider = await providerFactory.createTextProvider(options.keys);
        let qwenProviderPromise: ReturnType<LocalProviderFactory["createQwenProvider"]> | null = null;
        const perceiveVisually = async (timestampHints?: readonly string[]) => {
          const loadedImage = await options.loadImage(input.asset);
          qwenProviderPromise ??= providerFactory.createQwenProvider(options.keys);
          return perceiveScreenshot({
            image: loadedImage.image,
            note,
            ...(timestampHints ? { timestampHints } : {}),
            provider: await qwenProviderPromise,
            now: timestamp,
          });
        };
        let extraction: PerceptionResult;

        if (canUseOcr && options.perceiveOcr && options.perceiveOcrText) {
          let ocr: OcrPerceptionResult | null = null;
          let ocrRuntimeFailureNotice: string | null = null;

          try {
            ocr = await options.perceiveOcr(input.asset.uri);
          } catch (error) {
            ocrRuntimeFailureNotice = formatOcrRuntimeFailureNotice(error);
          }

          if (ocr) {
            traceOcrText = ocr.lines.map((line) => line.text).join("\n");
          }

          if (ocr && processing.exportOcrResults) {
            if (!options.exportOcr) {
              notices.push(OCR_EXPORT_FAILURE_NOTICE);
            } else {
              try {
                await options.exportOcr({
                  result: ocr,
                  asset: input.asset,
                });
              } catch {
                notices.push(OCR_EXPORT_FAILURE_NOTICE);
              }
            }
          }

          if (!ocr) {
            tracePerceptionPath = "ocr->cloud";
            notices.unshift(
              OCR_RUNTIME_FALLBACK_NOTICE,
              ocrRuntimeFailureNotice ?? formatOcrRuntimeFailureNotice(ocr),
            );
            extraction = await perceiveVisually();
          } else if (ocr.lines.length === 0) {
            tracePerceptionPath = "ocr->cloud";
            notices.unshift(OCR_EMPTY_FALLBACK_NOTICE);
            extraction = await perceiveVisually(collectOcrTimestampHints(ocr));
          } else if (isOcrTextQualityPoor(ocr)) {
            tracePerceptionPath = "ocr->cloud";
            notices.unshift(OCR_LOW_CONFIDENCE_FALLBACK_NOTICE);
            extraction = await perceiveVisually(collectOcrTimestampHints(ocr));
          } else {
            try {
              extraction = await options.perceiveOcrText({
                ocr,
                note,
                provider: textProvider,
                now: timestamp,
              });
              if (ocr.hasUnresolvedMessageSpeakers) {
                notices.unshift(OCR_SPEAKER_NOTICE);
              }
            } catch {
              tracePerceptionPath = "ocr->cloud";
              notices.unshift(OCR_FALLBACK_NOTICE);
              extraction = await perceiveVisually(collectOcrTimestampHints(ocr));
            }
          }
        } else {
          extraction = await perceiveVisually();
        }
        extraction = applySelfNames(extraction, processing.selfNames);
        traceExtraction = extraction;

        const contacts = [
          ...listResolvableContacts(options.store),
          ...(batchSession?.listPendingContacts() ?? []),
        ];
        const resolutions = await resolveParticipants({
          extraction,
          contacts,
          provider: textProvider,
        });
        traceResolutions = resolutions.map((resolution) => ({
          participant_name: resolution.participant_name,
          status: resolution.status,
          source: resolution.source,
          ...(resolution.status === "same_as"
            ? { contact_id: resolution.contact_id }
            : {}),
          ...(resolution.status === "unsure"
            ? { candidate_ids: [...resolution.candidate_ids] }
            : {}),
        }));
        const existingMeetings = options.store.listMeetings();
        const meetingProgressResolutions = await resolveMeetingProgress({
          extraction,
          meetings: existingMeetings,
          provider: textProvider,
        });
        const proposedCards = proposeCards(
          extraction,
          resolutions,
          contacts,
          timestamp,
          existingMeetings,
          meetingProgressResolutions,
        );
        traceProposedCards = proposedCards.map((card) => ({
          type: card.type,
          payload: card.payload,
          disambiguation: card.disambiguation ?? null,
        }));
        traceMeetingDedup = proposedCards.flatMap((card) =>
          card.type === "create_meeting"
            ? [{
                title: card.payload.title,
                ...(card.payload.duplicate_of_meeting_id != null
                  ? { duplicate_of_meeting_id: card.payload.duplicate_of_meeting_id }
                  : {}),
              }]
            : [],
        );
        let cards: ActionCardRecord[];
        let localBatchContactMerges: LocalBatchContactMerge[] | undefined;

        if (batchSession) {
          const plan = batchSession.prepareScreenshot({
            screenshotId: screenshot.id,
            batchIndex: input.localBatch!.index,
            extraction,
            resolutions,
            cards: proposedCards,
          });
          const savedCards = options.store.saveScreenshotAnalysis({
            screenshotId: screenshot.id,
            rawExtraction: extraction,
            cards: plan.cards,
            pendingCardUpdates: plan.pendingCardUpdates,
            createdAt: timestamp.toISOString(),
          });
          const updatedAnchorCards = new Map(
            plan.pendingCardUpdates.map((update) => {
              const card = options.store.getStoredActionCardById(update.cardId);
              if (!card) {
                throw new Error(`Updated anchor card ${update.cardId} not found`);
              }
              return [update.cardId, card];
            }),
          );
          const committed = batchSession.commitScreenshot({
            plan,
            savedCards,
            updatedAnchorCards,
          });
          cards = committed.cards;
          localBatchContactMerges = committed.merges;
          for (const cardId of committed.trackedCardIds) {
            batchSessionByCardId.set(cardId, batchSession);
          }
        } else {
          cards = options.store.saveScreenshotAnalysis({
            screenshotId: screenshot.id,
            rawExtraction: extraction,
            cards: proposedCards,
            createdAt: timestamp.toISOString(),
          });
        }

        const response = {
          screenshot_id: screenshot.id,
          cards,
          ...(notices.length ? { processing_notice: notices.join(" ") } : {}),
          ...(localBatchContactMerges?.length
            ? { local_batch_contact_merges: localBatchContactMerges }
            : {}),
        };
        await writeTraceBestEffort(traceState());
        return response;
      } catch (error) {
        try {
          options.store.deleteScreenshotUploadArtifacts(screenshot.id);
        } catch {
          // Preserve the processing error; cleanup can be retried during a later storage repair.
        }

        const trace = traceState();
        await writeTraceBestEffort({
          ...trace,
          error: describeTraceError(error),
        });

        throw error;
      }
    },
    async confirmCard(cardId, body = {}) {
      const batchSession = batchSessionByCardId.get(cardId);
      const storedCard = options.store.getStoredActionCardById(cardId);
      const prepared = storedCard
        ? preparePersistedLocalBatchConfirmation({
            card: storedCard,
            payload: body.payload ?? storedCard.payload,
            resolvedContactId: body.resolved_contact_id,
            getAnchorCard: (anchorCardId) =>
              options.store.getStoredActionCardById(anchorCardId),
          })
        : null;

      if (prepared && Object.prototype.hasOwnProperty.call(prepared, "disambiguation")) {
        const updated = options.store.updatePendingActionCard({
          cardId,
          disambiguation: prepared.disambiguation ?? null,
        });
        if (!updated) {
          throw new Error(`Pending action card ${cardId} could not be prepared for confirmation`);
        }
      }

      const execution = executeCard({
        db: options.store,
        cardId,
        payload: prepared?.payload ?? body.payload,
        resolvedContactId: prepared?.resolvedContactId ?? body.resolved_contact_id,
      });

      if (batchSession && execution.confirmedCard.resolved_contact_id != null) {
        batchSession.registerConfirmedContact(
          cardId,
          execution.confirmedCard.resolved_contact_id,
        );
      }

      try {
        const provider = await providerFactory.createTextProvider(options.keys);
        const insightResult = await generateInsights({
          db: options.store,
          contactIds: execution.affectedContactIds,
          provider,
          now: now(),
        });

        return {
          executed: true,
          card: execution.confirmedCard,
          affected_contact_ids: execution.affectedContactIds,
          observation_ids: execution.observationIds,
          ...(execution.meetingId != null ? { meeting_id: execution.meetingId } : {}),
          insight_status: "ok",
          insights: insightResult.generated,
        };
      } catch {
        return {
          executed: true,
          card: execution.confirmedCard,
          affected_contact_ids: execution.affectedContactIds,
          observation_ids: execution.observationIds,
          ...(execution.meetingId != null ? { meeting_id: execution.meetingId } : {}),
          insight_status: "failed",
          insight_error: "洞察生成失败，请检查模型配置后重试。",
          insights: [],
        };
      }
    },
    async rejectCard(cardId) {
      const batchSession = batchSessionByCardId.get(cardId);
      const card = rejectActionCard({ db: options.store, cardId });
      batchSession?.registerRejectedAnchor(cardId);
      return {
        card,
      };
    },
    async countPendingLocalBatchInteractionCards(anchorCardId) {
      return options.store.countPendingLocalBatchInteractionCards(anchorCardId);
    },
    async readDiagnosticsSnapshot() {
      return options.store.readDiagnosticsSnapshot();
    },
    async clearAllData() {
      options.store.clearAllData();
      batchSessionByCardId.clear();
    },
    async getContacts() {
      return options.store.listContacts();
    },
    async getContactDetail(contactId) {
      const detail = options.store.getContactDetail(contactId);

      if (!detail) {
        throw notFound("Contact", contactId);
      }

      return detail;
    },
    async getMeetings() {
      return options.store.listMeetings();
    },
    async getScreenshotDetail(screenshotId) {
      const detail = options.store.getScreenshotDetail(screenshotId);

      if (!detail) {
        throw notFound("Screenshot", screenshotId);
      }

      return {
        ...detail,
        cards: detail.cards.map((card) =>
          hydrateLocalBatchCardForResponse(
            card,
            (anchorCardId) => options.store.getStoredActionCardById(anchorCardId),
          )),
      };
    },
  };
}

function describeTraceError(error: unknown): { name: string; message: string } {
  try {
    if (error instanceof Error) {
      return {
        name: error.name || "Error",
        message: error.message || String(error),
      };
    }

    return {
      name: typeof error,
      message: String(error),
    };
  } catch {
    return {
      name: "Error",
      message: "无法读取错误信息",
    };
  }
}
