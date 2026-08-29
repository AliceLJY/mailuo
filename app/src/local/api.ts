import { executeCard, rejectCard as rejectActionCard } from "../../../shared/core/agent/execute.ts";
import { generateInsights } from "../../../shared/core/agent/insight.ts";
import { perceiveScreenshot } from "../../../shared/core/agent/perceive.ts";
import type { PerceptionResult } from "../../../shared/core/agent/perceive.ts";
import { proposeCards } from "../../../shared/core/agent/propose.ts";
import { resolveParticipants, type ResolvableContact } from "../../../shared/core/agent/resolve.ts";
import type { LocalLlmSecretStore } from "../connection/secrets";
import type { LocalProcessingSettings } from "../connection/config";
import type {
  ActionCardRecord,
  LocalBatchContactMerge,
  UploadImageAsset,
} from "../types";
import type { RoutedApi } from "../connection/dispatch";

import { createLocalProviderFactory, type LocalProviderFactory } from "./providers";
import type { OcrPerceptionResult } from "./perceive-ocr";
import {
  hydrateLocalBatchCardForResponse,
  preparePersistedLocalBatchConfirmation,
  type LocalBatchContactSession,
} from "./batch-contacts";
import type { LocalStore, ScreenshotImageLoader } from "./types";

const OCR_FALLBACK_NOTICE = "部分内容可能识别不全，已用云端模型重新处理。";
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

export function createLocalApi(options: CreateLocalApiOptions): RoutedApi {
  const providerFactory = options.providers ?? createLocalProviderFactory();
  const now = options.now ?? (() => new Date());
  const batchSessionByCardId = new Map<number, LocalBatchContactSession>();

  return {
    async uploadScreenshot(input) {
      const batchSession = input.localBatch?.session;
      batchSession?.reconcilePendingContacts((cardId) =>
        options.store.getStoredActionCardById(cardId),
      );
      const [loadedImage, textProvider, processing] = await Promise.all([
        options.loadImage(input.asset),
        providerFactory.createTextProvider(options.keys),
        options.getProcessingSettings?.() ?? Promise.resolve({
          perceptionPath: "cloud" as const,
          exportOcrResults: false,
        }),
      ]);
      const note = input.note?.trim() || undefined;
      const timestamp = now();
      const screenshot = options.store.createScreenshot({
        imagePath: loadedImage.imagePath,
        userNote: note ?? null,
        uploadedAt: timestamp.toISOString(),
      });

      try {
        let qwenProviderPromise: ReturnType<LocalProviderFactory["createQwenProvider"]> | null = null;
        const notices: string[] = [];
        const perceiveVisually = async () => {
          qwenProviderPromise ??= providerFactory.createQwenProvider(options.keys);
          return perceiveScreenshot({
            image: loadedImage.image,
            note,
            provider: await qwenProviderPromise,
            now: timestamp,
          });
        };
        let extraction: PerceptionResult;

        if (
          processing.perceptionPath === "ocr" &&
          options.perceiveOcr &&
          options.perceiveOcrText
        ) {
          let ocr: OcrPerceptionResult | null = null;

          try {
            ocr = await options.perceiveOcr(loadedImage.imagePath);
          } catch {
            // Recognition failure is handled by the original visual path below.
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

          if (!ocr || ocr.lines.length === 0 || ocr.degraded) {
            extraction = await perceiveVisually();
            notices.unshift(OCR_FALLBACK_NOTICE);
          } else {
            try {
              extraction = await options.perceiveOcrText({
                ocr,
                note,
                provider: textProvider,
                now: timestamp,
              });
            } catch {
              extraction = await perceiveVisually();
              notices.unshift(OCR_FALLBACK_NOTICE);
            }
          }
        } else {
          extraction = await perceiveVisually();
        }

        const contacts = [
          ...listResolvableContacts(options.store),
          ...(batchSession?.listPendingContacts() ?? []),
        ];
        const resolutions = await resolveParticipants({
          extraction,
          contacts,
          provider: textProvider,
        });
        const proposedCards = proposeCards(extraction, resolutions, contacts, timestamp);
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

        return {
          screenshot_id: screenshot.id,
          cards,
          ...(notices.length ? { processing_notice: notices.join(" ") } : {}),
          ...(localBatchContactMerges?.length
            ? { local_batch_contact_merges: localBatchContactMerges }
            : {}),
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
