import { z } from 'zod';
import { IdSchema } from '../domain/schema.js';

const Ids = z.array(IdSchema);
const References = z.looseObject({ fact_ids: Ids, clue_ids: Ids });
const ProductionUnit = z.looseObject({
  unit_id: IdSchema, segment_id: IdSchema, order: z.number().int().positive(),
  type: z.enum(['ACTION', 'DIALOGUE', 'NARRATION', 'SCREEN_TEXT', 'CHAT', 'NOTE', 'SOUND', 'MUSIC']),
  text: z.string().min(1), speaker_id: IdSchema.optional(), references: References,
});
export const ScreenplaySchema = z.looseObject({
  schema_family: z.literal('screenplay-units'), schema_version: z.literal('1.0.0'),
  project_id: IdSchema, title: z.string().min(1),
  scenes: z.array(z.looseObject({
    scene_id: IdSchema, order: z.number().int().positive(), title: z.string().min(1), location_id: IdSchema,
    segment_ids: Ids, context: z.looseObject({
      location_description: z.string(), background_music_description: z.string(),
      sound_cues: z.array(z.looseObject({ sound_cue_id: IdSchema, order: z.number().int().positive(), description: z.string() })),
    }), units: z.array(ProductionUnit),
  })).min(1),
});
export const PresentationSchema = z.looseObject({
  schema_family: z.literal('presentation-plan'), schema_version: z.enum(['2.0.0', '2.1.0']), project_id: IdSchema,
  modes: z.array(z.string().min(1)),
  segments: z.array(z.looseObject({
    segment_id: IdSchema, segment_type: z.string().min(1), scene_id: IdSchema,
    start_sec: z.number().nonnegative(), duration_sec: z.number().positive(),
    reaction_segment_id: IdSchema.optional(), revealed_fact_ids: Ids, revealed_clue_ids: Ids,
  })).min(1),
});
export const CharactersSchema = z.looseObject({
  project_id: IdSchema,
  characters: z.array(z.looseObject({ character_id: IdSchema, name: z.string().min(1), role: z.string() })),
});
export const PanelCastSchema = z.looseObject({
  schema_family: z.literal('panel-cast'), schema_version: z.literal('2.0.0'), project_id: IdSchema,
  panelists: z.array(z.looseObject({ panelist_id: IdSchema, display_name: z.string().min(1), persona: z.string() })),
});
export const ReactionsSchema = z.looseObject({
  schema_family: z.literal('reaction-segments'), schema_version: z.enum(['2.0.0', '2.1.0']), project_id: IdSchema,
  reaction_segments: z.array(z.looseObject({
    reaction_segment_id: IdSchema, after_scene_id: IdSchema, order: z.number().int().positive(),
    start_sec: z.number().nonnegative(), duration_sec: z.number().positive(),
    turns: z.array(z.looseObject({
      turn_id: IdSchema, panelist_id: IdSchema, spoken_line: z.string().min(1),
      evidence_ids: Ids, known_fact_ids: Ids,
    })),
  })),
});
export const SceneCardsSchema = z.looseObject({
  project_id: IdSchema, scenes: z.array(z.looseObject({
    scene_id: IdSchema, location_id: IdSchema, cast_ids: Ids,
  })),
});
export type ProductionScreenplay = z.infer<typeof ScreenplaySchema>;
export type ProductionPresentation = z.infer<typeof PresentationSchema>;
export type ProductionReactions = z.infer<typeof ReactionsSchema>;
