import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import type {
  ActionCardRecord,
  RecordInteractionPayload,
} from "../types.ts";

const reactNativeModuleSource = `
export const Pressable = () => null;
export const Text = () => null;
export const TextInput = () => null;
export const View = () => null;
export const StyleSheet = { create: (styles) => styles };
`;
const reactNativeModuleUrl = "mock:react-native";
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === reactNativeModuleUrl) {
      return {
        format: "module",
        shortCircuit: true,
        source: reactNativeModuleSource,
      };
    }

    return nextLoad(url, context);
  },
  resolve(specifier, context, nextResolve) {
    if (specifier === "react-native") {
      return { shortCircuit: true, url: reactNativeModuleUrl };
    }

    return nextResolve(specifier, context);
  },
});
const reviewFieldsPromise = import("../components/review/review-fields.tsx")
  .finally(() => hooks.deregister());

function createContactCard(
  status: ActionCardRecord["status"] = "pending",
): ActionCardRecord {
  return {
    id: 1,
    screenshot_id: 10,
    type: "create_contact",
    status,
    payload: { name: "王磊", aliases: ["王总"] },
    confidence: "high",
    source_quote: "王磊说下周继续推进",
    created_at: "2026-08-26T00:00:00.000Z",
    resolved_contact_id: status === "confirmed" ? 8 : null,
    resolved_at: status === "confirmed" ? "2026-08-26T00:01:00.000Z" : null,
  };
}

function interactionCard(
  overrides: Partial<ActionCardRecord> = {},
): ActionCardRecord {
  return {
    id: 2,
    screenshot_id: 10,
    type: "record_interaction",
    status: "pending",
    payload: {
      contact_name: "王磊",
      summary: "对方确认下周继续推进",
    },
    confidence: "high",
    source_quote: "下周继续推进",
    created_at: "2026-08-26T00:00:00.000Z",
    resolved_contact_id: null,
    resolved_at: null,
    ...overrides,
  } as ActionCardRecord;
}

test("review fields show and block a pending same-screenshot contact dependency", async () => {
  const {
    formatInteractionOwnership,
    getInteractionDependencyMessage,
    resolveReviewLocalBatchAnchor,
  } = await reviewFieldsPromise;
  const contact = createContactCard();
  const interaction = interactionCard();
  const payload = interaction.payload as RecordInteractionPayload;
  const anchor = resolveReviewLocalBatchAnchor(
    interaction,
    [contact, interaction],
    payload,
  );

  assert.deepEqual(anchor, {
    anchor_card_id: contact.id,
    name: "王磊",
    same_screenshot: true,
    status: "pending",
  });
  assert.equal(
    formatInteractionOwnership(payload, anchor),
    "将关联到本张新建的联系人：王磊（待确认）",
  );
  assert.equal(
    getInteractionDependencyMessage(anchor),
    "请先确认『新建联系人 王磊』那张卡",
  );
});

test("review fields show and block a rejected same-screenshot contact dependency", async () => {
  const {
    formatInteractionOwnership,
    getInteractionDependencyMessage,
    resolveReviewLocalBatchAnchor,
  } = await reviewFieldsPromise;
  const contact = createContactCard("rejected");
  const interaction = interactionCard();
  const payload = interaction.payload as RecordInteractionPayload;
  const anchor = resolveReviewLocalBatchAnchor(
    interaction,
    [contact, interaction],
    payload,
  );

  assert.equal(
    formatInteractionOwnership(payload, anchor),
    "将关联到本张新建的联系人：王磊（已被跳过）",
  );
  assert.equal(
    getInteractionDependencyMessage(anchor),
    "这张互动依赖的『新建联系人 王磊』已被跳过，请把这张也跳过，或先手动新建该联系人",
  );
});

test("review fields preserve cross-screenshot batch wording", async () => {
  const {
    formatInteractionOwnership,
    getInteractionDependencyMessage,
    resolveReviewLocalBatchAnchor,
  } = await reviewFieldsPromise;
  const contact = createContactCard();
  const interaction = interactionCard({
    screenshot_id: 11,
    disambiguation: {
      candidates: [],
      local_batch_anchor: {
        anchor_card_id: contact.id,
        name: "王磊",
        status: "pending",
      },
    },
  });
  const payload = interaction.payload as RecordInteractionPayload;
  const anchor = resolveReviewLocalBatchAnchor(
    interaction,
    [contact, interaction],
    payload,
  );

  assert.equal(
    formatInteractionOwnership(payload, anchor),
    "将关联到本批新建的联系人：王磊（待确认）",
  );
  assert.equal(getInteractionDependencyMessage(anchor), null);
});

test("review fields follow core precedence for multiple same-screenshot contacts", async () => {
  const {
    getInteractionDependencyMessage,
    resolveReviewLocalBatchAnchor,
  } = await reviewFieldsPromise;
  const interaction = interactionCard();
  const secondPendingContact = {
    ...createContactCard(),
    id: 3,
  } as ActionCardRecord;
  const pendingAnchor = resolveReviewLocalBatchAnchor(
    interaction,
    [createContactCard(), secondPendingContact, interaction],
    interaction.payload as RecordInteractionPayload,
  );

  assert.equal(pendingAnchor?.anchor_card_id, 1);
  assert.equal(
    getInteractionDependencyMessage(pendingAnchor),
    "请先确认『新建联系人 王磊』那张卡",
  );

  const confirmedContact = createContactCard("confirmed");
  assert.deepEqual(
    resolveReviewLocalBatchAnchor(
      interaction,
      [confirmedContact, secondPendingContact, interaction],
      interaction.payload as RecordInteractionPayload,
    ),
    {
      anchor_card_id: confirmedContact.id,
      name: "王磊",
      same_screenshot: true,
      status: "confirmed",
    },
  );

  const secondConfirmedContact = {
    ...createContactCard("confirmed"),
    id: 3,
    resolved_contact_id: 9,
  } as ActionCardRecord;
  assert.equal(
    resolveReviewLocalBatchAnchor(
      interaction,
      [confirmedContact, secondConfirmedContact, interaction],
      interaction.payload as RecordInteractionPayload,
    ),
    null,
  );
});

test("review fields do not replace an existing or deferred interaction link", async () => {
  const { resolveReviewLocalBatchAnchor } = await reviewFieldsPromise;
  const contact = createContactCard();
  const linkedPayload: RecordInteractionPayload = {
    contact_id: 8,
    contact_name: "王磊",
    summary: "对方确认下周继续推进",
  };
  const linkedInteraction = interactionCard({ payload: linkedPayload });
  const deferredInteraction = interactionCard({
    disambiguation: {
      candidates: [],
      local_batch_deferred: {
        version: 1,
        dependencies: [
          {
            kind: "record_interaction",
            anchor_card_id: contact.id,
          },
        ],
      },
    },
  });

  assert.equal(
    resolveReviewLocalBatchAnchor(
      linkedInteraction,
      [contact, linkedInteraction],
      linkedPayload,
    ),
    null,
  );
  assert.equal(
    resolveReviewLocalBatchAnchor(
      deferredInteraction,
      [contact, deferredInteraction],
      deferredInteraction.payload as RecordInteractionPayload,
    ),
    null,
  );
});
