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

/** A Sonnet reply that used the web_search server tool: result blocks (or an error object) then the answer text. */
export function searchReply(o: {
  text?: string;
  results?: { url: string; title: string }[];
  error?: string;
  searches?: number;
  stop_reason?: string;
}) {
  const content: unknown[] = [
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: o.error
        ? { type: 'web_search_tool_result_error', error_code: o.error }
        : (o.results ?? []).map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, encrypted_content: 'x', page_age: null })),
    },
  ];
  if (o.text !== undefined) content.push({ type: 'text', text: o.text });
  return {
    stop_reason: o.stop_reason ?? 'end_turn',
    content,
    usage: { ...usage(2000, 500), server_tool_use: { web_search_requests: o.searches ?? 1 } },
  };
}
