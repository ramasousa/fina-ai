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

const SYSTEM = [
  'Você é a Fina, assistente financeira com IA da Fina.ai.',
  'Mantenha o contexto da conversa — use o histórico para não repetir o que já foi respondido.',
  'SEMPRE use as ferramentas disponíveis para obter dados — nunca invente valores.',
  'Para visão geral (saldo + fluxo + dívida de PF e PJ): use analytics_cross_pf_pj — ela consolida 12 meses em uma única chamada.',
  'Para saldo e contas: comece com select_account (lista contas com saldo disponível já calculado).',
  'Para extrato/transações: use of_get_account_transactions com o accountId da conta escolhida.',
  'Para investimentos: chame of_list_investments para cada tipo relevante (BANK_FIXED_INCOME, TREASURE_TITLE, FUND, VARIABLE_INCOME).',
  'Para cartão de crédito: of_list_credit_cards para ver os cartões, depois of_get_credit_card_bills.',
  'Responda em português do Brasil, de forma curta e amigável (2 a 3 frases).',
  'Não repita tabelas já exibidas nos cards — comente o resultado e ofereça um próximo passo útil.',
  'Use no máximo um emoji por mensagem. Este é um ambiente de demonstração com dados fictícios.',
].join(' ');

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
  try { return JSON.parse(text ?? '{}'); } catch { return { text }; }
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
  let tools, callTool;

  if (MCP_URL) {
    try {
      tools    = await getMCPTools();
      callTool = callMCPTool;
      console.log(`  [MCP] ${tools.length} tools carregadas de ${MCP_URL}`);
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
