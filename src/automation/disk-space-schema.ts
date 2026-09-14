import { z } from 'zod';

const BytesSchema = z.string().regex(/^\d+$/u);
export const AutomationDiskReportSchema = z.strictObject({
  checkedAt: z.iso.datetime(), minimumFreeBytes: BytesSchema, sufficient: z.boolean(),
  volumes: z.array(z.strictObject({
    paths: z.array(z.string()), availableBytes: BytesSchema, requiredBytes: BytesSchema, sufficient: z.boolean(),
  })),
});
export type AutomationDiskReport = z.infer<typeof AutomationDiskReportSchema>;
