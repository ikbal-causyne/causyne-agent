import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '../src/tools/argumentValidation.js';

describe('validateToolArguments', () => {
  it('passes when value satisfies required properties and types', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        lines: { type: 'integer' }
      },
      required: ['path', 'content']
    };

    const validArgs = { path: '/tmp/test.txt', content: 'hello world', lines: 42 };
    const errors = validateToolArguments(validArgs, schema);
    assert.deepEqual(errors, []);
  });

  it('reports missing required properties', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    };

    const invalidArgs = { path: '/tmp/test.txt' };
    const errors = validateToolArguments(invalidArgs, schema);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /arguments\.content is required/);
  });

  it('reports type mismatches', () => {
    const schema = {
      type: 'object',
      properties: {
        timeout: { type: 'number' },
        flag: { type: 'boolean' }
      }
    };

    const invalidArgs = { timeout: 'not-a-number', flag: 'not-a-bool' };
    const errors = validateToolArguments(invalidArgs, schema);
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? '', /arguments\.timeout must be number/);
    assert.match(errors[1] ?? '', /arguments\.flag must be boolean/);
  });

  it('validates enum values', () => {
    const schema = {
      type: 'object',
      properties: {
        mediaType: { type: 'string', enum: ['image', 'audio_tts', 'video_animation'] }
      }
    };

    const valid = { mediaType: 'image' };
    assert.deepEqual(validateToolArguments(valid, schema), []);

    const invalid = { mediaType: 'unsupported_format' };
    const errors = validateToolArguments(invalid, schema);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /must be one of/);
  });
});
