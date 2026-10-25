// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HYDE_COMMAND_KEYS, HYDE_OPERATIONS } from './authoring';
import { HYDE_COMMAND_ARG_SCHEMAS_V1, HYDE_EXECUTE_SCHEMA_V1, HYDE_INSPECT_SCHEMA_V1 } from './sdkSchema';

type Shape = { required?: string[]; properties: Record<string, Record<string, unknown>>; [key: string]: unknown };
const args = (op: string) => HYDE_COMMAND_ARG_SCHEMAS_V1[op] as Shape;

describe('Hyde v1 command JSON Schema', () => {
  it('covers every registered operation with exactly its accepted top-level argument names', () => {
    expect(Object.keys(HYDE_COMMAND_ARG_SCHEMAS_V1).sort()).toEqual([...HYDE_OPERATIONS].sort());
    expect(HYDE_EXECUTE_SCHEMA_V1.properties.commands.items.oneOf.map(entry => entry.properties.op.const)).toEqual(HYDE_OPERATIONS);
    for (const op of HYDE_OPERATIONS) {
      const schema = args(op);
      expect(schema.type, op).toBe('object');
      expect(schema.additionalProperties, op).toBe(false);
      expect(Object.keys(schema.properties).sort(), op).toEqual([...HYDE_COMMAND_KEYS[op]].sort());
      expect((schema.required ?? []).every(key => HYDE_COMMAND_KEYS[op].includes(key)), op).toBe(true);
    }
    expect(HYDE_OPERATIONS.filter(op => !args(op).required).sort()).toEqual(['asset.removeUnused', 'project.updateMetadata']);
    expect(JSON.parse(JSON.stringify(HYDE_EXECUTE_SCHEMA_V1))).toEqual(HYDE_EXECUTE_SCHEMA_V1);
    expect(HYDE_INSPECT_SCHEMA_V1.properties.target.enum).toEqual(expect.arrayContaining(['environment', 'jobs']));
  });

  it('states creation, geometry, media, timeline, and staging requirements with useful value types', () => {
    expect(args('scene.create').required).toEqual(['name', 'start', 'duration']);
    expect(args('scene.create').properties.duration).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    expect(args('asset.add').properties.duration).toMatchObject({ type: 'number', exclusiveMinimum: 0, maximum: 86_400 });
    expect(args('asset.replace').properties.duration).toMatchObject({ type: 'number', exclusiveMinimum: 0, maximum: 86_400 });
    expect(args('element.create').properties.kind.enum).toContain('group');
    expect((args('element.create').properties.properties as Shape).properties.width).toMatchObject({ minimum: 0 });
    expect(args('element.setTransform').properties.space.enum).toEqual(['local', 'world']);
    expect(args('element.setTransform')).toMatchObject({
      if: { properties: { space: { const: 'world' } }, required: ['space'] },
      then: { properties: { transform: { additionalProperties: false, properties: { x: { type: 'number' }, rotation: { type: 'number' } } } } },
      else: { not: { required: ['timeSeconds'] } },
    });
    expect(args('shape.removePoint').required).toEqual(['id', 'index']);
    expect(args('shape.setPath').properties.path).toMatchObject({ type: 'object', properties: { points: { minItems: 3, maxItems: 4096 } } });
    expect(args('media.setPin').required).toEqual(['id', 'corners']);
    expect(args('media.setPin').properties.corners).toMatchObject({ anyOf: [{ minItems: 4, maxItems: 4 }, { type: 'null' }] });
    expect(args('camera.upsertKeyframe').properties.property.enum).toEqual(['x', 'y', 'zoom', 'rotation']);
    expect(args('keyframe.upsert').properties.property.enum).toContain('assetId');
    expect(args('asset.add').required).toEqual(['handle', 'name']);
    const effects = args('audio.setEffects').properties.effects as { type: string; maxItems: number; items: { oneOf: Array<{ properties: { type: { const: string } } }> } };
    expect(effects).toMatchObject({ type: 'array', maxItems: 16 });
    expect(effects.items.oneOf.map(effect => effect.properties.type.const)).toContain('echo');
  });

  it('describes conditional arguments without pretending JSON Schema validates graph relationships', () => {
    expect(args('text.setFont')).toMatchObject({ anyOf: [{ required: ['fontFamily'] }, { required: ['fontSize'] }] });
    expect(args('video.setSourceTiming')).toMatchObject({ dependentRequired: { inTime: ['outTime'], outTime: ['inTime'] } });
    expect(args('clip.editPlacedKey')).toMatchObject({ allOf: [
      { if: { properties: { action: { const: 'add' } } }, then: { required: ['timeSeconds'] } },
      { if: { properties: { action: { const: 'edit' } } }, then: { required: ['keyId', 'patch'] } },
      { if: { properties: { action: { const: 'remove' } } }, then: { required: ['keyId'] } },
    ] });
    expect(args('assembly.setLimits').properties.min).toMatchObject({ anyOf: [{ type: 'number' }, { type: 'null' }] });
    const unconstrained = HYDE_OPERATIONS.flatMap(op => Object.entries(args(op).properties)
      .filter(([, schema]) => !Object.keys(schema).length).map(([key]) => `${op}.${key}`));
    expect(unconstrained).toEqual([]);
  });
});
