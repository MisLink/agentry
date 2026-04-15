import test from 'node:test'
import assert from 'node:assert/strict'

import { buildLanguageOverride } from './index.ts'

test('buildLanguageOverride tells model to reply in same language as user input', () => {
  const override = buildLanguageOverride()

  assert.match(override, /same language as (the )?user(?:'s)? input/i)
})

test('buildLanguageOverride does not hard-pin Chinese or English', () => {
  const override = buildLanguageOverride()

  assert.doesNotMatch(override, /Respond in Chinese/i)
  assert.doesNotMatch(override, /Respond in English/i)
})
