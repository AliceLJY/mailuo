import { z } from 'zod';

import { MEETING_CHANGE_FIELDS, MEETING_KINDS } from '../types.ts';

export { ZodError } from 'zod';

export const CreateContactPayloadSchema = z
  .object({
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).optional(),
    company: z.string().optional(),
    title: z.string().optional(),
    phone: z.string().optional(),
    wechat_id: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const UpdateContactPayloadSchema = z
  .object({
    contact_id: z.number().int().positive(),
    contact_name: z.string().min(1),
    changes: z.record(
      z.string(),
      z
        .object({
          old: z.string().nullable(),
          new: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const MeetingParticipantSchema = z
  .object({
    contact_id: z.number().int().positive().optional(),
    name: z.string().min(1),
  })
  .strict();

export const CreateMeetingPayloadSchema = z
  .object({
    kind: z.enum(MEETING_KINDS).default('meeting'),
    title: z.string().min(1),
    time_iso: z.string().nullable(),
    time_text: z.string(),
    location: z.string().optional(),
    participants: z.array(MeetingParticipantSchema),
    agenda: z.string().optional(),
    agenda_append: z.string().trim().min(1).optional(),
    duplicate_of_meeting_id: z.number().int().positive().optional(),
    changes: z
      .partialRecord(
        z.enum(MEETING_CHANGE_FIELDS),
        z
          .object({
            old: z.string().nullable(),
            new: z.string().nullable(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.duplicate_of_meeting_id != null && payload.changes == null) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate meeting cards require a changes map',
        path: ['changes'],
      });
    }

    if (payload.duplicate_of_meeting_id == null && payload.changes != null) {
      context.addIssue({
        code: 'custom',
        message: 'meeting changes require duplicate_of_meeting_id',
        path: ['duplicate_of_meeting_id'],
      });
    }

    if (payload.agenda_append != null && payload.duplicate_of_meeting_id == null) {
      context.addIssue({
        code: 'custom',
        message: 'agenda append cards require duplicate_of_meeting_id',
        path: ['duplicate_of_meeting_id'],
      });
    }
  });

export const RecordInteractionPayloadSchema = z
  .object({
    contact_id: z.number().int().positive().optional(),
    contact_name: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export const ConfirmCardBodySchema = z
  .object({
    payload: z.unknown().optional(),
    resolved_contact_id: z.number().int().positive().optional(),
  })
  .strict();

export type ConfirmCardBody = z.infer<typeof ConfirmCardBodySchema>;
