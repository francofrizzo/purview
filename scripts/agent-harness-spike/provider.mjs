import http from 'node:http';

// Deterministic model transport, NOT a model or a quality evaluation. The real
// harness still decides which tools exist and whether/how a call executes.
export async function provider() {
  const requests = [];
  let plan = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(404).end(); return; }
    if (req.url.includes('count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    requests.push({ path: req.url, body });
    const next = plan.shift() ?? { text: 'spike-done' };
    if (next.hold) return; // Cancellation fixture: never return model output.
    const id = `call_${requests.length}`;
    const declarations = body.tools ?? body.input?.find(i => i.type === 'additional_tools')?.tools ?? [];
    const tools = declarations.flatMap(t => t.type === 'namespace' ? t.tools.map(x => ({ ...x, namespace: t.name })) : [t]);
    const selected = next.tool && tools.find(t => (t.name ?? '').endsWith(next.tool));
    const name = next.forceTool ?? selected?.name;
    if (next.tool && !name) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Fixture tool missing: ${next.tool}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (req.url.includes('/messages')) {
      event('message_start', { message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      const block = name ? { type: 'tool_use', id, name, input: {} } : { type: 'text', text: '' };
      event('content_block_start', { index: 0, content_block: block });
      event('content_block_delta', { index: 0, delta: name
        ? { type: 'input_json_delta', partial_json: JSON.stringify(next.args) }
        : { type: 'text_delta', text: next.text ?? 'spike-done' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      event('message_stop', {});
    } else {
      const item = next.customInput
        ? { type: 'custom_tool_call', id: `ct_${id}`, call_id: id, name, ...(selected?.namespace ? { namespace: selected.namespace } : {}), input: next.customInput, status: 'completed' }
        : name
        ? { type: 'function_call', id: `fc_${id}`, call_id: id, name, ...(selected?.namespace ? { namespace: selected.namespace } : {}), arguments: JSON.stringify(next.args), status: 'completed' }
        : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: next.text ?? 'spike-done', annotations: [] }] };
      const response = { id: `resp_${id}`, object: 'response', model: body.model, output: [], status: 'in_progress' };
      event('response.created', { response });
      event('response.output_item.added', { output_index: 0, item: name ? { ...item, arguments: '', status: 'in_progress' } : item });
      if (next.customInput) event('response.custom_tool_call_input.delta', { item_id: item.id, output_index: 0, delta: next.customInput });
      else if (name) event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
      else event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: next.text ?? 'spike-done' });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    plan: steps => { plan = [...steps]; }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
