// ─────────────────────────────────────────────────────────────
// Fina.ai — Backend do assistente financeiro com IA.
//
//   Navegador (fina-chat.html)
//        │  POST /api/chat  { messages: [...] }
//        ▼
//   Este servidor  ── guarda a ANTHROPIC_API_KEY ──▶  API da Anthropic
//        │                                                 │ tool_use
//        │  executa a tool contra o mock-bank              ▼
//        └───────────────  tool_result  ◀──────────────────┘
//
// A chave da Anthropic NUNCA vai ao navegador. Em produção, o
// executor da tool usaria o token do usuário (OAuth/Open Finance) para
// bater nas APIs bancárias reais — aqui usamos dados fictícios (mock-bank.js).
// ─────────────────────────────────────────────────────────────

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { tools, executores } from './mock-bank.js';

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const hasKey = !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = [
  'Você é a Fina, assistente financeira com IA da Fina.ai.',
  'Ajude o usuário a consultar saldo total, extrato, gastos por categoria, PIX e investimentos.',
  'Use SEMPRE as ferramentas disponíveis para obter os dados — nunca invente valores.',
  'Responda em português do Brasil, de forma curta, cordial e clara (1 a 3 frases).',
  'Não repita a tabela de dados que a ferramenta já mostra em card; apenas comente o resultado',
  'e ofereça um próximo passo útil. Use no máximo um emoji por mensagem.',
  'Este é um ambiente de demonstração com dados fictícios.',
].join(' ');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static('.')); // serve fina-chat.html, index.html, etc.

// O front usa isto para decidir entre modo real (Claude) e simulado.
app.get('/api/health', (_req, res) => {
  res.json({ ready: hasKey, model: MODEL });
});

app.post('/api/chat', async (req, res) => {
  if (!hasKey) {
    return res.status(503).json({ error: 'no_key', message: 'ANTHROPIC_API_KEY não configurada.' });
  }

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!incoming.length) return res.status(400).json({ error: 'empty', message: 'messages vazio.' });

  const client = new Anthropic();
  const messages = incoming.map((m) => ({ role: m.role, content: m.content }));
  const steps = []; // tools executadas nesta rodada (o front renderiza os cards)

  try {
    // Loop agêntico: repete enquanto o Claude pedir tools.
    for (let i = 0; i < 6; i++) {
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

      // Registra o turno do assistente e executa cada tool pedida.
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const fn = executores[block.name];
        const out = fn ? fn(block.input || {}) : { data: { erro: 'tool desconhecida' }, meta: '' };
        steps.push({ tool: block.name, meta: out.meta, data: out.data });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(out.data),
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
  console.log(`  Chat demo →  http://localhost:${PORT}/fina-chat.html`);
  console.log(`  Modelo: ${MODEL}`);
  console.log(
    hasKey
      ? '  Modo: REAL (conectado à API da Anthropic) ✅\n'
      : '  Modo: sem ANTHROPIC_API_KEY → o front cairá no modo SIMULADO.\n',
  );
});
