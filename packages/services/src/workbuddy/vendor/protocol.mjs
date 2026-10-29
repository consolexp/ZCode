'use strict';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
var MAX_BYTES = 16 * 1024 * 1024;
function responseRequest(wb, body) {
  if (body.previous_response_id || body.conversation || body.background) throw new Error('此通道需要完整 input 历史，不支持服务端会话续接或后台响应。');
  if (body.n && body.n !== 1) throw new Error('此通道每次只支持一个回答。');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new Error('tools 须为列表。');
  if ((body.tools || []).some(function (t) { return !t || t.type !== 'function'; })) throw new Error('此通道仅支持 function 工具，请关闭其他工具类型。');
  if (Array.isArray(body.input)) body.input.forEach(function (item) {
    if (!['message', 'function_call', 'function_call_output', 'reasoning', undefined].includes(item.type)) throw new Error('此通道不支持该 input 类型：' + item.type);
    if (Array.isArray(item.content)) item.content.forEach(function (part) {
      if (!['input_text', 'output_text', 'text', 'input_image', 'image_url'].includes(part.type)) throw new Error('此通道只支持文本、图片和函数工具。');
    });
  });
  var chat = wb.responsesToChat(body);
  if (body.reasoning && body.reasoning.effort) chat.reasoning_effort = body.reasoning.effort;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  return chat;
}
function modelMatches(actual, expected) {
  return actual === expected || (actual.startsWith(expected + '-') && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(expected.length + 1)));
}
async function* events(stream) {
  var decoder = new StringDecoder('utf8'), buffer = '';
  for await (var chunk of stream) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.byteLength(buffer) > MAX_BYTES) throw new Error('上游单个事件超过 16 MiB。');
    var match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      var block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      var data = block.split(/\r?\n/).filter(function (line) { return line.startsWith('data:'); }).map(function (line) { return line.slice(5).trimStart(); }).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { yield { done: true }; continue; }
      yield { event: JSON.parse(data) };
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) throw new Error('上游事件流未完整结束。');
}
function write(res, text) {
  if (res.destroyed) return Promise.reject(new Error('客户端已断开。'));
  if (res.write(text)) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    function clean() { res.removeListener('drain', drain); res.removeListener('close', close); }
    function drain() { clean(); resolve(); }
    function close() { clean(); reject(new Error('客户端已断开。')); }
    res.once('drain', drain); res.once('close', close);
  });
}
async function relay(stream, res, options) {
  var wb = options.wb, alias = options.alias, expected = options.expected;
  var started = false, verified = false, finished = false, seq = 0, total = 0;
  var id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex'), created = Math.floor(Date.now() / 1000), usage = null, finishReason = 'stop';
  var content = '', reasoning = '', calls = new Map(), items = [], message = null, thinking = null;
  var respId = 'resp_' + crypto.randomBytes(12).toString('hex');
  var send = async function (type, value) { await write(res, 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type: type, sequence_number: seq++ }, value)) + '\n\n'); };
  function response(status) { return { id: respId, object: 'response', created_at: created, status: status, model: alias, output: items, parallel_tool_calls: true, usage: wb.mapUsage(usage) }; }
  async function start() {
    if (started || !options.stream) return;
    started = true; res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    if (options.responses) { await send('response.created', { response: response('in_progress') }); await send('response.in_progress', { response: response('in_progress') }); }
  }
  async function add(item) {
    item._index = items.length; items.push(item);
    var visible = Object.assign({}, item); delete visible._index;
    await send('response.output_item.added', { output_index: item._index, item: visible });
  }
  for await (var packet of events(stream)) {
    if (packet.done) { if (!finished) throw new Error('上游没有完整完成标记。'); break; }
    var ev = packet.event;
    if (ev.error) throw new Error(ev.error.message || '上游生成失败。');
    if (ev.model) {
      if (!modelMatches(ev.model, expected)) throw new Error('上游返回模型与映射目标不一致。');
      verified = true;
    }
    var choice = ev.choices && ev.choices[0], delta = choice && choice.delta || {};
    if (!verified) {
      if (delta.content || delta.reasoning_content || delta.tool_calls) throw new Error('上游未提供可验证的模型。');
      continue;
    }
    await start();
    if (ev.id) id = ev.id;
    if (ev.created) created = ev.created;
    if (ev.usage) usage = ev.usage;
    if (choice && choice.finish_reason) { finished = true; finishReason = choice.finish_reason; }
    var text = delta.content || '', thought = delta.reasoning_content || '';
    total += Buffer.byteLength(text + thought + JSON.stringify(delta.tool_calls || []));
    if (total > MAX_BYTES) throw new Error('上游回答超过 16 MiB。');
    content += text; reasoning += thought;
    if (options.stream && !options.responses) await write(res, 'data: ' + JSON.stringify(Object.assign({}, ev, { model: alias })) + '\n\n');
    if (options.stream && options.responses && thought) {
      if (!thinking) {
        thinking = { id: 'rs_' + respId, type: 'reasoning', summary: [] }; await add(thinking);
        await send('response.reasoning_summary_part.added', { item_id: thinking.id, output_index: thinking._index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      await send('response.reasoning_summary_text.delta', { item_id: thinking.id, output_index: thinking._index, summary_index: 0, delta: thought });
    }
    if (options.stream && options.responses && text) {
      if (!message) {
        message = { id: 'msg_' + respId, type: 'message', role: 'assistant', status: 'in_progress', content: [] }; await add(message);
        await send('response.content_part.added', { item_id: message.id, output_index: message._index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      await send('response.output_text.delta', { item_id: message.id, output_index: message._index, content_index: 0, delta: text });
    }
    for (var tc of delta.tool_calls || []) {
      var index = tc.index === undefined ? 0 : tc.index;
      if (!Number.isInteger(index) || index < 0 || index > 127) throw new Error('无效的工具调用序号。');
      var call = calls.get(index);
      if (!call) { call = { id: tc.id || 'call_' + crypto.randomBytes(8).toString('hex'), type: 'function', function: { name: '', arguments: '' }, item: null }; calls.set(index, call); }
      if (tc.id) call.id = tc.id;
      if (tc.function && tc.function.name) call.function.name += tc.function.name;
      var args = tc.function && tc.function.arguments || ''; call.function.arguments += args;
      if (options.stream && options.responses) {
        if (!call.item) { call.item = { id: 'fc_' + call.id, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.function.name, arguments: '' }; await add(call.item); }
        if (args) await send('response.function_call_arguments.delta', { item_id: call.item.id, output_index: call.item._index, delta: args });
      }
    }
  }
  if (!verified || !finished) throw new Error('上游回答提前结束，未得到完整结果。');
  var incomplete = ['length', 'content_filter'].includes(finishReason);
  if (!['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(finishReason)) throw new Error('未知的上游完成原因。');
  var toolCalls = Array.from(calls.values()).map(function (call) { return { id: call.id, type: 'function', function: call.function }; });
  if (options.stream) {
    if (options.responses) {
      for (var item of items) {
        if (item === thinking) {
          item.summary = [{ type: 'summary_text', text: reasoning }];
          await send('response.reasoning_summary_text.done', { item_id: item.id, output_index: item._index, summary_index: 0, text: reasoning });
          await send('response.reasoning_summary_part.done', { item_id: item.id, output_index: item._index, summary_index: 0, part: item.summary[0] });
        } else if (item === message) {
          item.status = incomplete ? 'incomplete' : 'completed'; item.content = [{ type: 'output_text', text: content, annotations: [] }];
          await send('response.output_text.done', { item_id: item.id, output_index: item._index, content_index: 0, text: content });
          await send('response.content_part.done', { item_id: item.id, output_index: item._index, content_index: 0, part: item.content[0] });
        } else {
          var owner = Array.from(calls.values()).find(function (call) { return call.item === item; });
          item.status = incomplete ? 'incomplete' : 'completed'; item.call_id = owner.id; item.name = owner.function.name; item.arguments = owner.function.arguments;
          await send('response.function_call_arguments.done', { item_id: item.id, output_index: item._index, arguments: item.arguments });
        }
        var outputIndex = item._index; delete item._index;
        await send('response.output_item.done', { output_index: outputIndex, item: item });
      }
      var finalResponse = response(incomplete ? 'incomplete' : 'completed');
      if (incomplete) finalResponse.incomplete_details = { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' };
      await send(incomplete ? 'response.incomplete' : 'response.completed', { response: finalResponse });
    } else await write(res, 'data: [DONE]\n\n');
    res.end();
  } else {
    var msg = { role: 'assistant', content: content || null };
    if (reasoning) msg.reasoning_content = reasoning;
    if (toolCalls.length) msg.tool_calls = toolCalls;
    var cc = { id: id, object: 'chat.completion', created: created, model: alias, choices: [{ index: 0, message: msg, finish_reason: finishReason }], usage: usage };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    var result = options.responses ? wb.chatToResponseObject(cc) : cc;
    if (options.responses && incomplete) {
      result.status = 'incomplete'; result.incomplete_details = { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' };
      result.output.forEach(function (item) { if (item.status) item.status = 'incomplete'; });
    }
    res.end(JSON.stringify(result));
  }
}
export { responseRequest, relay, events, modelMatches };
