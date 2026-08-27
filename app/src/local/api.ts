import { executeCard, rejectCard as rejectActionCard } from "../../../shared/core/agent/execute.ts";
import { generateInsights } from "../../../shared/core/agent/insight.ts";
import { perceiveScreenshot } from "../../../shared/core/agent/perceive.ts";
import { proposeCards } from "../../../shared/core/agent/propose.ts";
import { resolveParticipants, type ResolvableContact } from "../../../shared/core/agent/resolve.ts";
import type { LocalLlmSecretStore } from "../connection/secrets";
import type { RoutedApi } from "../connection/dispatch";

import { createLocalProviderFactory, type LocalProviderFactory } from "./providers";
import type { LocalStore, ScreenshotImageLoader } from "./types";

export type CreateLocalApiOptions = {
  store: LocalStore;
  keys: LocalLlmSecretStore;
  loadImage: ScreenshotImageLoader;
  providers?: LocalProviderFactory;
  now?: () => Date;
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

  return {
    async uploadScreenshot(input) {
      const [loadedImage, qwenProvider, textProvider] = await Promise.all([
        options.loadImage(input.asset),
        providerFactory.createQwenProvider(options.keys),
        providerFactory.createTextProvider(options.keys),
      ]);
      const note = input.note?.trim() || undefined;
      const timestamp = now();
      const screenshot = options.store.createScreenshot({
        imagePath: loadedImage.imagePath,
        userNote: note ?? null,
        uploadedAt: timestamp.toISOString(),
      });

      try {
        const extraction = await perceiveScreenshot({
          image: loadedImage.image,
          note,
          provider: qwenProvider,
          now: timestamp,
        });
        const contacts = listResolvableContacts(options.store);
        const resolutions = await resolveParticipants({
          extraction,
          contacts,
          provider: textProvider,
        });
        const cards = options.store.saveScreenshotAnalysis({
          screenshotId: screenshot.id,
          rawExtraction: extraction,
          cards: proposeCards(extraction, resolutions, contacts, timestamp),
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
    async confirmCard(cardId, body = {}) {
      const execution = executeCard({
        db: options.store,
        cardId,
        payload: body.payload,
        resolvedContactId: body.resolved_contact_id,
      });

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
      return {
        card: rejectActionCard({ db: options.store, cardId }),
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

      return detail;
    },
  };
}
