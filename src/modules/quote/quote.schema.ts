import { z } from 'zod';

const entity = z.object({
  type: z.enum([
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'code',
    'pre',
    'spoiler',
    'blockquote',
    'url',
    'text_link',
  ]),
  offset: z.number().int().min(0).max(4096),
  length: z.number().int().min(1).max(4096),
  url: z.string().max(2048).optional(),
});
const entities = z
  .array(entity)
  .max(100)
  .nullish()
  .transform((value) => value ?? []);
const remoteURL = z
  .string()
  .max(4096)
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port
      );
    } catch {
      return false;
    }
  }, 'Images must use an HTTP(S) URL without credentials or a custom port.');
const textFields = z.object({ text: z.string().max(4096).default(''), entities });
const reply = textFields
  .extend({ name: z.string().max(200), chatId: z.number().int().safe().default(0) })
  .strict();
const message = textFields
  .extend({
    avatar: z.boolean().default(true),
    from: z
      .object({
        id: z.number().int().safe(),
        name: z.string().max(200),
        photo: z
          .object({ url: remoteURL.default('') })
          .strict()
          .default({ url: '' }),
      })
      .strict(),
    media: z
      .object({ url: remoteURL.refine((value) => value.length > 0) })
      .strict()
      .optional(),
    replyMessage: reply.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.text.trim() && !value.media)
      ctx.addIssue({ code: 'custom', message: 'A message needs text or an image.' });
    for (const block of [value, value.replyMessage]) {
      if (block && block.entities.some((item) => item.offset + item.length > block.text.length)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Entity offsets must fit the UTF-16 text length.',
        });
      }
    }
  });

export const quoteSchema = z
  .object({
    type: z.enum(['quote', 'image', 'stories']).default('quote'),
    format: z.enum(['png', 'webp']).default('png'),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#FFFFFF'),
    width: z.number().int().min(128).max(768).default(512),
    height: z.number().int().min(128).max(768).default(512),
    scale: z.number().min(1).max(3).default(2),
    messages: z.array(message).min(1).max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.width * value.height * value.scale ** 2 * value.messages.length > 8_000_000) {
      ctx.addIssue({
        code: 'custom',
        message: 'Quote canvas dimensions exceed the rendering budget.',
      });
    }
    if (
      value.messages.reduce(
        (sum, item) => sum + item.text.length + (item.replyMessage?.text.length || 0),
        0,
      ) > 8000
    ) {
      ctx.addIssue({ code: 'custom', message: 'Total message text exceeds 8000 characters.' });
    }
  });

export type QuotePayload = z.infer<typeof quoteSchema>;
export interface QuoteResult {
  image: string;
  type: string;
  width: number;
  height: number;
}
