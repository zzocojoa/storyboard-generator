import { z } from 'zod';
import { FrameSchema, HandoffSchema, NativeDatasetSchema, ProjectSchema, ShotSchema } from '../src/domain/schema.js';
import { GeneratorBuildProvenanceSchema } from '../src/domain/schema.js';
import { CodexRequestSchema } from '../src/codex/request-schema.js';
import { ApplyIntentSchema } from '../src/codex/apply-schema.js';

export function schemaArtifacts(): { name: string; content: string }[] {
  const schemas = [
    { name: 'storyboard_handoff.schema.json', schema: HandoffSchema },
    { name: 'storyboard_project.schema.json', schema: ProjectSchema },
    { name: 'storyboard_frame.schema.json', schema: FrameSchema },
    { name: 'shot.schema.json', schema: ShotSchema },
    { name: 'native_dataset.schema.json', schema: NativeDatasetSchema },
    { name: 'codex_request.schema.json', schema: CodexRequestSchema.omit({ generatorBuild: true }).extend({ generatorBuild: GeneratorBuildProvenanceSchema.nullable().optional() }) },
    { name: 'codex_apply_intent.schema.json', schema: ApplyIntentSchema },
  ];
  return schemas.map(({ name, schema }) => ({ name, content: `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'ref' }), null, 2)}\n` }));
}
