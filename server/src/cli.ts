import { stderr, stdout } from 'node:process';

import type { ActionCardRecord } from '../../shared/types.ts';
import { executeCard } from './agent/execute.ts';
import { generateInsights } from './agent/insight.ts';
import { perceiveScreenshot } from './agent/perceive.ts';
import { proposeCards } from '../../shared/core/agent/propose.ts';
import { resolveParticipants, type ResolvableContact } from './agent/resolve.ts';
import { MailuoDb } from './db.ts';
import type { PerceptionResult } from './agent/perceive.ts';
import type { ParticipantResolution } from './agent/resolve.ts';
import { ConfigurationError, ProviderRequestError, StructuredOutputError } from './llm/provider.ts';

type CommonCommandArgs = { imagePath: string; note?: string };

function parseCommonArgs(command: string, args: string[]): CommonCommandArgs {
  if (args.length === 0) {
    throw new Error(`Usage: ${command} <image> [--note text]`);
  }

  const [imagePath, ...rest] = args;
  let note: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === '--note') {
      const next = rest[index + 1];

      if (!next) {
        throw new Error('Missing value for --note');
      }

      note = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return { imagePath, note };
}

function listResolvableContacts(db: MailuoDb): ResolvableContact[] {
  return db.listContacts().map(
    ({ observation_count: _observationCount, last_interaction_at: _lastInteractionAt, ...contact }) =>
      contact,
  );
}

async function runPerceiveResolvePropose(args: {
  db: MailuoDb;
  imagePath: string;
  note?: string;
  perceiveScreenshotImpl?: typeof perceiveScreenshot;
  resolveParticipantsImpl?: typeof resolveParticipants;
}): Promise<{
  extraction: PerceptionResult;
  resolutions: ParticipantResolution[];
  contacts: ResolvableContact[];
}> {
  const perceiveScreenshotImpl = args.perceiveScreenshotImpl ?? perceiveScreenshot;
  const resolveParticipantsImpl = args.resolveParticipantsImpl ?? resolveParticipants;
  const extraction = await perceiveScreenshotImpl({
    imagePath: args.imagePath,
    note: args.note,
  });
  const contacts = listResolvableContacts(args.db);
  const resolutions = await resolveParticipantsImpl({ extraction, contacts });

  return { extraction, resolutions, contacts };
}

function sortCardsForExecution<T extends Pick<ActionCardRecord, 'id' | 'type'>>(cards: T[]): T[] {
  const priority: Record<ActionCardRecord['type'], number> = {
    create_contact: 0,
    update_contact: 1,
    create_meeting: 2,
    record_interaction: 3,
  };

  return [...cards].sort((left, right) => {
    const priorityDelta = priority[left.type] - priority[right.type];
    return priorityDelta !== 0 ? priorityDelta : left.id - right.id;
  });
}

function getPublicErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof ConfigurationError) {
    return error.message;
  }

  if (error instanceof ProviderRequestError) {
    return error.message;
  }

  if (error instanceof StructuredOutputError) {
    return error.message;
  }

  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

type RunE2eFlowArgs = {
  db: MailuoDb;
  imagePath: string;
  note?: string;
  perceiveScreenshotImpl?: typeof perceiveScreenshot;
  resolveParticipantsImpl?: typeof resolveParticipants;
  proposeCardsImpl?: typeof proposeCards;
  executeCardImpl?: typeof executeCard;
  generateInsightsImpl?: typeof generateInsights;
};

export async function runE2eFlow(args: RunE2eFlowArgs) {
  const screenshot = args.db.createScreenshot({
    imagePath: args.imagePath,
    userNote: args.note ?? null,
  });
  let analysisPersisted = false;

  try {
    const { extraction, resolutions, contacts } = await runPerceiveResolvePropose({
      db: args.db,
      imagePath: args.imagePath,
      note: args.note,
      perceiveScreenshotImpl: args.perceiveScreenshotImpl,
      resolveParticipantsImpl: args.resolveParticipantsImpl,
    });
    const proposeCardsImpl = args.proposeCardsImpl ?? proposeCards;
    const executeCardImpl = args.executeCardImpl ?? executeCard;
    const generateInsightsImpl = args.generateInsightsImpl ?? generateInsights;
    const savedCards = args.db.saveScreenshotAnalysis({
      screenshotId: screenshot.id,
      rawExtraction: extraction,
      cards: proposeCardsImpl(
        extraction,
        resolutions,
        contacts,
        undefined,
        args.db.listMeetings(),
      ),
    });
    analysisPersisted = true;
    const executionResults = sortCardsForExecution(savedCards).map((card) =>
      executeCardImpl({
        db: args.db,
        cardId: card.id,
      }),
    );
    const affectedContactIds = [...new Set(executionResults.flatMap((result) => result.affectedContactIds))];
    const observationIds = [...new Set(executionResults.flatMap((result) => result.observationIds))];
    const meetingIds = executionResults.flatMap((result) =>
      result.meetingId != null ? [result.meetingId] : [],
    );
    let insights: Awaited<ReturnType<typeof generateInsights>>['generated'] = [];
    let insightStatus: 'ok' | 'failed' = 'ok';
    let insightError: string | undefined;

    try {
      const insightResult = await generateInsightsImpl({
        db: args.db,
        contactIds: affectedContactIds,
      });
      insights = insightResult.generated;
    } catch (error) {
      insightStatus = 'failed';
      insightError = getPublicErrorMessage(error, 'Unexpected insight generation error');
    }

    const detail = args.db.getScreenshotDetail(screenshot.id);
    return {
      screenshot_id: screenshot.id,
      extraction,
      resolutions,
      cards: detail?.cards ?? [],
      executed: true,
      confirmed_card_ids: executionResults.map((result) => result.confirmedCard.id),
      affected_contact_ids: affectedContactIds,
      observation_ids: observationIds,
      meeting_ids: meetingIds,
      insight_status: insightStatus,
      ...(insightError ? { insight_error: insightError } : {}),
      insights,
    };
  } catch (error) {
    if (!analysisPersisted) {
      args.db.deleteScreenshotUploadArtifacts(screenshot.id);
    }

    throw error;
  }
}

async function runExtractCommand(args: CommonCommandArgs): Promise<void> {
  const db = new MailuoDb();

  try {
    const { extraction, resolutions, contacts } = await runPerceiveResolvePropose({
      db,
      imagePath: args.imagePath,
      note: args.note,
    });
    const cards = proposeCards(
      extraction,
      resolutions,
      contacts,
      undefined,
      db.listMeetings(),
    );
    stdout.write(`${JSON.stringify(cards, null, 2)}\n`);
  } finally {
    db.close();
  }
}

async function runE2eCommand(args: CommonCommandArgs): Promise<void> {
  const db = new MailuoDb();

  try {
    const result = await runE2eFlow({
      db,
      imagePath: args.imagePath,
      note: args.note,
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  if (command !== 'extract' && command !== 'e2e') {
    throw new Error('Usage: extract <image> [--note text]\n       e2e <image> [--note text]');
  }

  const args = parseCommonArgs(command, rest);

  if (command === 'extract') {
    await runExtractCommand(args);
    return;
  }

  await runE2eCommand(args);
}

const isMainModule = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
