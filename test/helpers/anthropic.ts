/** Canned Messages API responses for the mocked @anthropic-ai/sdk client. */
const usage = (input = 1000, output = 200) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

export function toolReply(name: string, input: unknown, u = usage()) {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name, input }], usage: u };
}

export function jsonReply(value: unknown, u = usage(3000, 900)) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }], usage: u };
}

export function textReply(text: string, stop_reason = 'end_turn') {
  return { stop_reason, content: [{ type: 'text', text }], usage: usage() };
}
