// ─────────────────────────────────────────────────────────────
// Fina.ai — Backend do assistente financeiro com IA.
//
//   Navegador (dashboard.html)
//        │  POST /api/chat  { messages: [...] }
//        ▼
//   Este servidor  ── (1) MCP → mcp-conta-demo.onrender.com/mcp
//        │          ── (2) fallback: mock-bank.js (local)
//        ▼
//   Anthropic API (Claude) — tool_use loop
//
// Configure MCP_SERVER_URL para conectar ao mesmo servidor MCP
// que alimenta o Claude Desktop, Claude.ai e WhatsApp.
// ─────────────────────────────────────────────────────────────

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { tools as mockTools, executores as mockExecutores } from './mock-bank.js';

const PORT      = process.env.PORT           || 3000;
const MODEL     = process.env.CLAUDE_MODEL   || 'claude-haiku-4-5-20251001';
const MCP_URL   = process.env.MCP_SERVER_URL;  // ex: https://mcp-conta-demo.onrender.com
const MCP_TOKEN = process.env.MCP_API_TOKEN;   // Bearer token (se MCP_REQUIRE_AUTH=true)
const hasKey    = !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `Você é a Fina, assistente financeira com IA da Fina.ai.
Perfil demo: Raul Sousa — PF corrente (pf-cc-0001), poupança (pf-poup-0001) e PJ Sousa Tech Ltda (pj-cc-0001), Bradesco, cartão de crédito e investimentos.

REGRA 1 — SEMPRE USE FERRAMENTAS: Chame a ferramenta ANTES de qualquer resposta com dados. NUNCA responda de memória, mesmo que os dados já estejam no histórico da conversa. Se o usuário pedir extrato, saldo, gastos ou qualquer dado financeiro — mesmo que você já tenha buscado antes — chame a ferramenta de NOVO. A ferramenta é obrigatória em toda resposta com dados financeiros. NUNCA diga "não tenho acesso", "não tenho ferramenta" ou qualquer limitação — você tem acesso total a todos os dados via ferramentas.

REGRA 2 — MAPA DE FERRAMENTAS (use exatamente esta ferramenta para cada pedido):
• Saldo das contas → select_account
• Visão geral / patrimônio PF+PJ → analytics_cross_pf_pj
• Extrato / transações PF → of_get_account_transactions com accountId=pf-cc-0001
• Extrato / transações PJ → of_get_account_transactions com accountId=pj-cc-0001
• Gastos / categorias / gráfico PF → consultar_gastos com conta=pf
• Gastos / categorias / gráfico PJ → consultar_gastos com conta=pj
• Fatura / cartão de crédito → consultar_fatura
• PIX / transferências → consultar_pix

REGRA 3 — GRÁFICOS E VISUALIZAÇÕES: Quando o usuário pedir gráfico, chart, pizza, visualização, análise visual ou distribuição por categoria → chame consultar_gastos. O app renderiza o gráfico automaticamente — JAMAIS diga que não tem ferramenta para gráficos.

REGRA 4 — CONTA PJ: Você tem acesso COMPLETO à conta PJ Sousa Tech Ltda. Para extrato PJ: of_get_account_transactions(accountId=pj-cc-0001). Para gastos/categorias PJ: consultar_gastos(conta=pj). NUNCA diga que só tem dados PF ou que precisa de relatório externo para a PJ.

REGRA 5 — APÓS FERRAMENTA: O card já exibe os dados visualmente. Escreva apenas 1 frase de resumo + 1 próximo passo sugerido. NUNCA liste categorias, contas ou transações no texto — já aparecem no card. NUNCA diga "o card exibe" ou faça referência ao card — apenas resuma o dado mais relevante em 1 frase.

Responda em português do Brasil, curto e amigável. Sem markdown (sem *, -, #, **). Máximo 1 emoji. Dados são fictícios.`;

// ── MCP client — JSON-RPC sobre Streamable HTTP ───────────────────
// Node 18+ tem fetch nativo; não precisamos de dependências extras.
async function mcpPost(method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (MCP_TOKEN) headers['Authorization'] = `Bearer ${MCP_TOKEN}`;

  const res = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 401) {
    throw new Error('MCP não autorizado — defina MCP_REQUIRE_AUTH=false no servidor banking-mcp');
  }

  const ct   = res.headers.get('content-type') || '';
  const text = await res.text();

  // O Streamable HTTP pode responder JSON ou SSE; tratamos ambos.
  let json;
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s.startsWith('data:')) {
        const chunk = s.slice(5).trim();
        if (chunk && chunk !== '[DONE]') {
          try { json = JSON.parse(chunk); break; } catch {}
        }
      }
    }
  } else {
    try { json = JSON.parse(text); } catch {}
  }

  if (!json)           throw new Error(`MCP: resposta inválida para ${method}`);
  if (json.error)      throw new Error(`MCP ${json.error.code}: ${json.error.message}`);
  return json.result;
}

// Cache de tools — evita buscar a cada request (TTL 5 min).
let _mcpTools = null, _mcpToolsAt = 0;

async function getMCPTools() {
  if (_mcpTools && Date.now() - _mcpToolsAt < 300_000) return _mcpTools;

  // Alguns servidores exigem initialize antes de tools/list.
  try {
    await mcpPost('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'fina-ai', version: '1.0.0' },
    });
  } catch { /* ignora — alguns servidores stateless dispensam o handshake */ }

  const result = await mcpPost('tools/list', {});
  _mcpTools = (result.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
  _mcpToolsAt = Date.now();
  return _mcpTools;
}

async function callMCPTool(name, args) {
  const result = await mcpPost('tools/call', { name, arguments: args || {} });
  const text   = (result.content || []).find((b) => b.type === 'text')?.text;
  let parsed;
  try { parsed = JSON.parse(text ?? '{}'); } catch { return { text }; }
  // Strip banking-mcp { data, meta:string } wrapper so MCP responses match mock-bank shape.
  // OF envelopes also have 'links' at root, so only strip when 'links' is absent.
  if (parsed && parsed.data !== undefined && typeof parsed.meta === 'string' && !('links' in parsed)) {
    return parsed.data;
  }
  return parsed;
}

// ── Express ────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static('.'));

// O front usa este endpoint para escolher entre modo real e simulado.
app.get('/api/health', (_req, res) => {
  res.json({ ready: hasKey, model: MODEL, mcp: !!MCP_URL });
});

app.post('/api/chat', async (req, res) => {
  if (!hasKey) {
    return res.status(503).json({ error: 'no_key', message: 'ANTHROPIC_API_KEY não configurada.' });
  }

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!incoming.length) return res.status(400).json({ error: 'empty', message: 'messages vazio.' });

  // Seleciona a fonte de tools: MCP server ou mock-bank local.
  // Quando MCP está ativo, mesclamos com as extensões do mock-bank que não existem no MCP
  // (ex: consultar_gastos, consultar_fatura, consultar_pix) para que Claude possa chamá-las.
  let tools, callTool;

  if (MCP_URL) {
    try {
      const mcpList  = await getMCPTools();
      const mcpNames = new Set(mcpList.map((t) => t.name));
      const mockExt  = mockTools.filter((t) => !mcpNames.has(t.name));
      tools = [...mcpList, ...mockExt];
      callTool = async (name, args) => {
        if (!mcpNames.has(name)) {
          // Extensão mock-only (ex: consultar_gastos) — executa localmente.
          const fn = mockExecutores[name];
          return fn ? fn(args || {}).data : { erro: 'tool desconhecida' };
        }
        return callMCPTool(name, args);
      };
      console.log(`  [MCP] ${mcpList.length} tools MCP + ${mockExt.length} extensões mock`);
    } catch (err) {
      console.warn(`  [MCP] falhou, usando mock-bank: ${err.message}`);
    }
  }

  if (!tools) {
    tools    = mockTools;
    callTool = (name, args) => {
      const fn = mockExecutores[name];
      return fn ? fn(args || {}).data : { erro: 'tool desconhecida' };
    };
  }

  const client   = new Anthropic();
  // O histórico completo de mensagens é enviado pelo cliente a cada request.
  const messages = incoming.map((m) => ({ role: m.role, content: m.content }));
  const steps    = [];

  try {
    // Loop agêntico: repete enquanto Claude pedir tools.
    for (let i = 0; i < 8; i++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        tools,
        messages,
      });

      if (response.stop_reason !== 'tool_use') {
        const texto = response.content.find((b) => b.type === 'text')?.text ?? '';
        return res.json({ reply: texto, steps });
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let data;
        try {
          data = await callTool(block.name, block.input || {});
        } catch (err) {
          data = { erro: err.message };
        }
        steps.push({ tool: block.name, data });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(data),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return res.json({ reply: 'Desculpe, não consegui concluir a consulta agora.', steps });
  } catch (err) {
    const status = err?.status || 500;
    console.error('Erro /api/chat:', err?.message || err);
    return res.status(status).json({ error: 'anthropic_error', message: err?.message || 'Falha na API.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Fina.ai  →  http://localhost:${PORT}`);
  console.log(`  Dados: ${MCP_URL ? `MCP → ${MCP_URL}` : 'mock-bank (local, sem MCP_SERVER_URL)'}`);
  console.log(hasKey
    ? '  Anthropic API: REAL ✅\n'
    : '  Anthropic API: sem chave → front cairá no modo simulado\n',
  );
});
