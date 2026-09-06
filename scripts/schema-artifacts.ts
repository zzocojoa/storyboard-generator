import { z } from 'zod';
import { FrameSchema, HandoffSchema, NativeDatasetSchema, ProjectSchema, ShotSchema } from '../src/domain/schema.js';

export function schemaArtifacts(): { name: string; content: string }[] {
  const schemas = [
    { name: 'storyboard_handoff.schema.json', schema: HandoffSchema },
    { name: 'storyboard_project.schema.json', schema: ProjectSchema },
    { name: 'storyboard_frame.schema.json', schema: FrameSchema },
    { name: 'shot.schema.json', schema: ShotSchema },
    { name: 'native_dataset.schema.json', schema: NativeDatasetSchema },
  ];
  return schemas.map(({ name, schema }) => ({ name, content: `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'ref' }), null, 2)}\n` }));
}
