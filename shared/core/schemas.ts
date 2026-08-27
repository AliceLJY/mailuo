import { z } from 'zod';

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
    title: z.string().min(1),
    time_iso: z.string().nullable(),
    time_text: z.string().min(1),
    location: z.string().optional(),
    participants: z.array(MeetingParticipantSchema),
    agenda: z.string().optional(),
  })
  .strict();

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
