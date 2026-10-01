import { describe, expect, it } from 'vitest'
import { MAX_SUGGESTION_LENGTH, parseSuggestions } from '../suggest-parse.js'

describe('parseSuggestions', () => {
  it('reads the OpenSearch shape', () => {
    expect(parseSuggestions('["test",["test adsl","test webcam","testosterone"]]', 'test')).toEqual(['test adsl', 'test webcam', 'testosterone'])
  })

  it('reads a list of objects, by phrase or by value', () => {
    expect(parseSuggestions('[{"phrase":"cats"},{"phrase":"cat food"}]', 'ca')).toEqual(['cats', 'cat food'])
    expect(parseSuggestions('[{"value":"a b"}]', 'a')).toEqual(['a b'])
  })

  it('reads the wrapped list', () => {
    expect(parseSuggestions('{"status":"success","data":{"items":[{"value":"test","suggestType":0},{"value":"testbook"}]}}', 'te')).toEqual(['test', 'testbook'])
  })

  it('keeps at most four', () => {
    expect(parseSuggestions('["q",["a1","a2","a3","a4","a5","a6"]]', 'a')).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('drops the text itself, repeats, and what is not a string', () => {
    expect(parseSuggestions('["Cats",["cats","CATS"," cats kittens","cats kittens",5,null,{"a":1},["x"],""]]', 'cats')).toEqual(['cats kittens'])
  })

  it('cleans control characters and whitespace out of a label', () => {
    expect(parseSuggestions('["q",["one\\ntwo\\t three","bell\\u0007ring","\\u202ehidden"]]', 'q')).toEqual(['one two three', 'bell ring', 'hidden'])
  })

  it('drops a suggestion over 200 characters', () => {
    expect(parseSuggestions(JSON.stringify(['q', ['x'.repeat(MAX_SUGGESTION_LENGTH + 1), 'y'.repeat(MAX_SUGGESTION_LENGTH)]]), 'q')).toEqual(['y'.repeat(MAX_SUGGESTION_LENGTH)])
  })

  it.each(['', 'not json', 'null', '7', '"text"', '{}', '{"data":[]}', '[]', '["q"]', '["q",5]', '{"data":{"items":7}}'])('gives nothing for %j', (body) => {
    expect(parseSuggestions(body, 'q')).toEqual([])
  })
})
