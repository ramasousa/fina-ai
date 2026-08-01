// ─────────────────────────────────────────────────────────────
// Mock Bank — dados fictícios de saldo, extrato, gastos, PIX e fatura.
//
// Em produção, cada função aqui bateria no Core Bancário via Axway,
// usando o token do usuário autenticado (Authorization Code + PKCE).
// Aqui geramos dados fictícios ricos e ESTÁVEIS (RNG com semente fixa
// e data de referência fixa), para o demo ser previsível.
//
// Formatos preservados (consumidos por bradesco-chat.html):
//   saldo   → { ag, conta, disponivel, bloqueado, limite }
//   extrato → { grupos:[{ day, items:[{desc,cat,val,dir,ic}] }], ... }
//   gastos  → { gastos:[{cat,val,color,pct}], total, maior }
//   pix     → { pix:[{desc,val,dir,when,ic}], ... }
// ─────────────────────────────────────────────────────────────

// Data de referência fixa (mantém o demo estável). "Hoje" = 23/jul/2026.
const HOJE = { y: 2026, m: 7, d: 23 };
const MES_NOME = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mm = (m) => String(m).padStart(2, '0');
const dd = (d) => String(d).padStart(2, '0');

// PRNG determinístico (LCG) — dados iguais a cada boot.
function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const money = (rng, min, max) => Number((min + rng() * (max - min)).toFixed(2));

// Paleta para os gráficos de categoria.
const PALETA = [
  '#CC092F', '#ff7a45', '#9b87f5', '#4ea8de', '#38b000', '#f4a261',
  '#e76f51', '#2a9d8f', '#8338ec', '#3a86ff', '#ffbe0b', '#fb5607',
  '#06d6a0', '#118ab2', '#ef476f', '#7209b7',
];

// Catálogo de estabelecimentos por categoria (compras variadas).
const CATALOGO = [
  { cat: 'Supermercado', ic: '🛒', lojas: ['Pão de Açúcar', 'Carrefour', 'Assaí', 'Extra', 'Dia', 'Hortifruti'], min: 90, max: 680 },
  { cat: 'Restaurantes', ic: '🍽️', lojas: ['Outback', 'Coco Bambu', 'Madero', 'Sushi Yassu', 'Paris 6', 'Fogo de Chão'], min: 70, max: 640 },
  { cat: 'Delivery', ic: '🍔', lojas: ['iFood', 'Rappi', 'Zé Delivery', "McDonald's", 'Burger King', 'China in Box'], min: 28, max: 190 },
  { cat: 'Transporte/App', ic: '🚗', lojas: ['Uber', '99', 'Cabify'], min: 12, max: 110 },
  { cat: 'Combustível', ic: '⛽', lojas: ['Shell', 'Ipiranga', 'Petrobras', 'Ale'], min: 150, max: 480 },
  { cat: 'Saúde/Farmácia', ic: '💊', lojas: ['Drogasil', 'Droga Raia', 'Pague Menos', 'Consulta Dr. Alves', 'Lab Fleury'], min: 40, max: 720 },
  { cat: 'Vestuário', ic: '👕', lojas: ['Renner', 'Zara', 'C&A', 'Riachuelo', 'Nike', 'Adidas'], min: 90, max: 950 },
  { cat: 'Eletrônicos', ic: '💻', lojas: ['Amazon', 'Magazine Luiza', 'Fast Shop', 'Kabum', 'Apple Store'], min: 180, max: 3200 },
  { cat: 'Viagem/Hospedagem', ic: '✈️', lojas: ['Latam', 'Gol', 'Booking', 'Airbnb', 'Decolar', 'Azul'], min: 350, max: 2800 },
  { cat: 'Assinaturas/Streaming', ic: '🎬', lojas: ['Netflix', 'Spotify', 'Amazon Prime', 'Disney+', 'HBO Max', 'YouTube Premium'], min: 20, max: 70 },
  { cat: 'Lazer/Entretenimento', ic: '🎟️', lojas: ['Cinemark', 'Ingresso.com', 'Steam', 'PlayStation Store', 'Teatro'], min: 45, max: 420 },
  { cat: 'Beleza/Estética', ic: '💇', lojas: ['Studio W', 'Barbearia Corleone', 'Sephora', 'O Boticário'], min: 55, max: 520 },
  { cat: 'Casa/Móveis', ic: '🛋️', lojas: ['Tok&Stok', 'Leroy Merlin', 'IKEA', 'MadeiraMadeira'], min: 130, max: 2400 },
  { cat: 'Pet', ic: '🐶', lojas: ['Petz', 'Cobasi', 'Petlove'], min: 60, max: 460 },
  { cat: 'Educação', ic: '📚', lojas: ['Alura', 'Udemy', 'Amazon Livros', 'Coursera'], min: 40, max: 700 },
];

// ─────────────────────────────────────────────────────────────
// CONTA CORRENTE — saldo de seis dígitos + 6 meses de extrato.
// ─────────────────────────────────────────────────────────────
export const CONTA = {
  ag: '1234-5',
  conta: '56789-0',
  disponivel: 137842.55,
  bloqueado: 450.0,
  limite: 15000.0, // cheque especial
  poupanca: 61230.18,
  rendimento_mes: 842.37,
};

// Gera ~6 meses de lançamentos (fev→jul 2026) agrupados por dia.
function gerarExtrato() {
  const rng = rngFrom(20260723);
  const porDia = new Map();
  const add = (y, mo, d, item) => {
    const key = `${y}-${mm(mo)}-${dd(d)}`;
    if (!porDia.has(key)) porDia.set(key, { y, mo, d, items: [] });
    porDia.get(key).items.push(item);
  };

  for (let mo = 2; mo <= 7; mo++) {
    const y = 2026;
    const ultimoDia = mo === HOJE.m ? HOJE.d : 28;

    // Recorrentes (crédito e contas fixas)
    add(y, mo, 5, { desc: 'Salário · Empresa XPTO Ltda', cat: 'Crédito em conta', val: 12500.0, dir: 'in', ic: '💼' });
    add(y, mo, 20, { desc: 'PIX recebido · Consultoria ABC', cat: 'Transferência', val: money(rng, 1500, 4200), dir: 'in', ic: '⚡' });
    add(y, mo, 1, { desc: 'Rendimento poupança', cat: 'Rendimentos', val: money(rng, 380, 620), dir: 'in', ic: '📈' });
    add(y, mo, 8, { desc: 'Aluguel · Imobiliária Lar', cat: 'Moradia', val: -3200.0, dir: 'out', ic: '🏠' });
    add(y, mo, 8, { desc: 'Condomínio · Ed. Aurora', cat: 'Moradia', val: -1180.0, dir: 'out', ic: '🏢' });
    add(y, mo, 10, { desc: 'Enel · Energia elétrica', cat: 'Contas', val: -money(rng, 210, 460), dir: 'out', ic: '💡' });
    add(y, mo, 11, { desc: 'Sabesp · Água', cat: 'Contas', val: -money(rng, 90, 180), dir: 'out', ic: '🚿' });
    add(y, mo, 15, { desc: 'Vivo Fibra · Internet', cat: 'Contas', val: -159.9, dir: 'out', ic: '🌐' });
    add(y, mo, 12, { desc: 'Pagamento fatura cartão Bradesco', cat: 'Cartão de crédito', val: -money(rng, 9000, 15000), dir: 'out', ic: '💳' });
    add(y, mo, 6, { desc: 'Aplicação · CDB Bradesco', cat: 'Investimentos', val: -money(rng, 2000, 5000), dir: 'out', ic: '🏦' });

    // Compras variadas (débito) — 14 a 20 por mês
    const nCompras = 14 + Math.floor(rng() * 7);
    for (let i = 0; i < nCompras; i++) {
      const c = pick(rng, CATALOGO);
      const d = 1 + Math.floor(rng() * ultimoDia);
      add(y, mo, d, {
        desc: pick(rng, c.lojas),
        cat: c.cat,
        val: -money(rng, c.min, Math.min(c.max, 900)),
        dir: 'out',
        ic: c.ic,
      });
    }

    // PIX enviados — 3 a 5 por mês
    const nPix = 3 + Math.floor(rng() * 3);
    const destinos = ['Maria Souza', 'Padaria do Zé', 'João P. Silva', 'Diarista Ana', 'Escola Infantil', 'Personal Trainer'];
    for (let i = 0; i < nPix; i++) {
      const d = 1 + Math.floor(rng() * ultimoDia);
      add(y, mo, d, { desc: `PIX enviado · ${pick(rng, destinos)}`, cat: 'Transferência', val: -money(rng, 40, 850), dir: 'out', ic: '⚡' });
    }
  }

  // Ordena por data (mais recente primeiro) e rotula o dia.
  const chave = (g) => g.y * 10000 + g.mo * 100 + g.d;
  const grupos = [...porDia.values()].sort((a, b) => chave(b) - chave(a));
  return grupos.map((g) => {
    const ehHoje = g.mo === HOJE.m && g.d === HOJE.d;
    const ehOntem = g.mo === HOJE.m && g.d === HOJE.d - 1;
    const rotulo = `${g.d} ${MES_NOME[g.mo - 1]}`;
    return {
      date: `${g.y}-${mm(g.mo)}-${dd(g.d)}`,
      day: ehHoje ? `Hoje · ${rotulo}` : ehOntem ? `Ontem · ${rotulo}` : rotulo,
      items: g.items,
    };
  });
}

const EXTRATO = gerarExtrato();

// ─────────────────────────────────────────────────────────────
// CARTÃO DE CRÉDITO — 4 faturas (abr→jul 2026), gastos altos/variados.
// ─────────────────────────────────────────────────────────────
function agrupaCategoria(lancamentos) {
  const mapa = new Map();
  for (const l of lancamentos) mapa.set(l.cat, (mapa.get(l.cat) || 0) + l.val);
  const total = [...mapa.values()].reduce((s, v) => s + v, 0);
  return [...mapa.entries()]
    .map(([cat, val]) => ({ cat, val: Number(val.toFixed(2)) }))
    .sort((a, b) => b.val - a.val)
    .map((x, i) => ({ ...x, pct: Math.round((x.val / total) * 100), color: PALETA[i % PALETA.length] }));
}

function gerarFaturas() {
  const rng = rngFrom(99887766);
  const LIMITE = 45000.0;
  // Compras parceladas que atravessam várias faturas.
  const parcelados = [
    { desc: 'Notebook Dell Inspiron', cat: 'Eletrônicos', ic: '💻', total: 6499.0, parcelas: 10, inicio: { y: 2026, m: 3 } },
    { desc: 'Passagens Latam · GRU-LIS', cat: 'Viagem/Hospedagem', ic: '✈️', total: 8760.0, parcelas: 6, inicio: { y: 2026, m: 5 } },
    { desc: 'iPhone 16 Pro · Apple', cat: 'Eletrônicos', ic: '📱', total: 9999.0, parcelas: 12, inicio: { y: 2026, m: 4 } },
  ];

  const faturas = [];
  for (let m = 4; m <= 7; m++) {
    const y = 2026;
    const lanc = [];

    // Parcelas ativas nesta competência
    for (const p of parcelados) {
      const idx = y * 12 + m - (p.inicio.y * 12 + p.inicio.m);
      if (idx >= 0 && idx < p.parcelas) {
        lanc.push({
          data: `${dd(3 + Math.floor(rng() * 5))}/${mm(m)}`,
          desc: `${p.desc} · ${idx + 1}/${p.parcelas}`,
          cat: p.cat,
          ic: p.ic,
          val: Number((p.total / p.parcelas).toFixed(2)),
        });
      }
    }

    // Compras avulsas — 20 a 30 por fatura, valores altos
    const n = 20 + Math.floor(rng() * 11);
    for (let i = 0; i < n; i++) {
      const c = pick(rng, CATALOGO);
      lanc.push({
        data: `${dd(1 + Math.floor(rng() * 28))}/${mm(m)}`,
        desc: pick(rng, c.lojas),
        cat: c.cat,
        ic: c.ic,
        val: money(rng, c.min, c.max),
      });
    }

    lanc.sort((a, b) => (a.data < b.data ? 1 : -1));
    const total = Number(lanc.reduce((s, l) => s + l.val, 0).toFixed(2));
    const porCat = agrupaCategoria(lanc);
    const status = m === HOJE.m ? 'aberta' : m === HOJE.m - 1 ? 'fechada' : 'paga';
    const mVenc = m === 12 ? 1 : m + 1;

    faturas.push({
      competencia: `${y}-${mm(m)}`,
      status,
      fechamento: `28/${mm(m)}`,
      vencimento: `07/${mm(mVenc)}`,
      total,
      limite: LIMITE,
      limite_disponivel: Number((LIMITE - total).toFixed(2)),
      qtd_lancamentos: lanc.length,
      maior_categoria: porCat[0]?.cat,
      por_categoria: porCat,
      lancamentos: lanc,
    });
  }
  return faturas.reverse(); // mais recente primeiro
}

const FATURAS = gerarFaturas();

// ─────────────────────────────────────────────────────────────
// Agregações auxiliares
// ─────────────────────────────────────────────────────────────
function totais(grupos) {
  let entradas = 0;
  let saidas = 0;
  for (const g of grupos)
    for (const it of g.items) {
      if (it.val >= 0) entradas += it.val;
      else saidas += Math.abs(it.val);
    }
  return { entradas: Number(entradas.toFixed(2)), saidas: Number(saidas.toFixed(2)) };
}

// Filtra o extrato pelos últimos N dias (relativo à data de referência).
function extratoUltimosDias(dias) {
  const ref = new Date(HOJE.y, HOJE.m - 1, HOJE.d);
  const limite = new Date(ref);
  limite.setDate(limite.getDate() - dias);
  return EXTRATO.filter((g) => new Date(`${g.date}T00:00:00`) >= limite);
}

// Gastos por categoria (débitos) num período AAAA-MM, a partir do extrato.
function gastosDoMes(periodo) {
  const grupos = EXTRATO.filter((g) => g.date.startsWith(periodo));
  const mapa = new Map();
  for (const g of grupos)
    for (const it of g.items)
      if (it.val < 0) mapa.set(it.cat, (mapa.get(it.cat) || 0) + Math.abs(it.val));
  const total = [...mapa.values()].reduce((s, v) => s + v, 0);
  const gastos = [...mapa.entries()]
    .map(([cat, val]) => ({ cat, val: Number(val.toFixed(2)) }))
    .sort((a, b) => b.val - a.val)
    .map((x, i) => ({ ...x, pct: Math.round((x.val / total) * 100), color: PALETA[i % PALETA.length] }));
  return { gastos, total: Number(total.toFixed(2)), maior: gastos[0]?.cat };
}

// ── "Executores" das tools ──────────────────────────────────────
export const executores = {
  consultar_saldo() {
    return {
      data: { ...CONTA },
      meta: 'GET /contas/v1/saldo · apiId core-bancario-api · 312ms',
    };
  },

  consultar_extrato(input = {}) {
    const dias = input.dias ?? 30;
    const grupos = extratoUltimosDias(dias);
    const { entradas, saidas } = totais(grupos);
    return {
      data: {
        dias,
        grupos,
        entradas,
        saidas,
        lancamentos: grupos.reduce((n, g) => n + g.items.length, 0),
        conta: CONTA.conta,
      },
      meta: `GET /contas/v1/extrato?dias=${dias} · apiId core-bancario-api · 287ms`,
    };
  },

  consultar_gastos(input = {}) {
    const periodo = input.periodo ?? `${HOJE.y}-${mm(HOJE.m)}`;
    const { gastos, total, maior } = gastosDoMes(periodo);
    return {
      data: { periodo, gastos, total, maior },
      meta: `GET /contas/v1/extrato?periodo=${periodo} · agregação por categoria · 341ms`,
    };
  },

  consultar_pix() {
    // Deriva os PIX recentes do próprio extrato (mais recentes primeiro).
    const pix = [];
    for (const g of EXTRATO) {
      for (const it of g.items) {
        if (it.cat === 'Transferência' && it.ic === '⚡') {
          pix.push({
            desc: it.desc.replace('PIX enviado · ', 'Enviado · ').replace('PIX recebido · ', 'Recebido · '),
            val: it.val,
            dir: it.dir,
            when: g.day,
            ic: '⚡',
          });
        }
      }
      if (pix.length >= 12) break;
    }
    const enviados = pix.filter((p) => p.dir === 'out').length;
    const recebidos = pix.filter((p) => p.dir === 'in').length;
    return {
      data: { pix, enviados, recebidos, conta: CONTA.conta },
      meta: 'GET /contas/v1/extrato?tipo=PIX · apiId core-bancario-api · 264ms',
    };
  },

  consultar_fatura(input = {}) {
    const comp = input.competencia;
    if (comp) {
      const f = FATURAS.find((x) => x.competencia === comp);
      if (!f) {
        return {
          data: { erro: `Fatura ${comp} não encontrada.`, competencias_disponiveis: FATURAS.map((x) => x.competencia) },
          meta: `GET /cartoes/v1/faturas/${comp} · apiId cartoes-api · 298ms`,
        };
      }
      return { data: f, meta: `GET /cartoes/v1/faturas/${comp} · apiId cartoes-api · 305ms` };
    }
    // Sem competência: fatura atual + histórico resumido das 4 competências.
    const historico = FATURAS.map((x) => ({
      competencia: x.competencia,
      status: x.status,
      total: x.total,
      vencimento: x.vencimento,
      maior_categoria: x.maior_categoria,
    }));
    return {
      data: { fatura_atual: FATURAS[0], historico },
      meta: 'GET /cartoes/v1/faturas · apiId cartoes-api · 322ms',
    };
  },
};

// ── Definição das tools no formato da API da Anthropic ──────────
// (core.js converte input_schema → inputSchema para o MCP.)
export const tools = [
  {
    name: 'consultar_saldo',
    description:
      'Retorna o saldo disponível e bloqueado da conta corrente do usuário autenticado, poupança e limite do cheque especial. Use quando o usuário perguntar sobre saldo, quanto tem na conta ou quanto está disponível.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_conta: { type: 'string', enum: ['corrente', 'poupanca'], description: 'Tipo de conta a consultar.' },
      },
    },
  },
  {
    name: 'consultar_extrato',
    description:
      'Retorna as movimentações (lançamentos) da conta corrente em um período recente, com créditos e débitos, agrupados por dia. Há histórico de ~6 meses. Use quando o usuário pedir extrato, movimentações, últimos lançamentos ou histórico.',
    input_schema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Janela do extrato em dias (relativa a hoje). Ex: 7, 30, 90, 180. Padrão 30.' },
      },
    },
  },
  {
    name: 'consultar_gastos',
    description:
      'Retorna os gastos (débitos) de um mês agregados por categoria e o total. Use quando o usuário perguntar quanto gastou, sobre despesas ou gastos por categoria da conta corrente.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', description: 'Mês no formato AAAA-MM. Ex: 2026-07. Padrão: mês corrente.' },
      },
    },
  },
  {
    name: 'consultar_pix',
    description:
      'Retorna as movimentações PIX recentes (enviados e recebidos) da conta corrente. Use quando o usuário perguntar sobre PIX.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_fatura',
    description:
      'Retorna a fatura do cartão de crédito com lançamentos detalhados, total, vencimento, limite e gastos por categoria. Há histórico de 4 meses (competências). Sem parâmetro, devolve a fatura atual (aberta) mais um resumo das últimas 4 competências. Informe "competencia" (AAAA-MM) para o detalhamento de um mês específico. Use quando o usuário perguntar sobre fatura, cartão de crédito, gastos no cartão ou vencimento da fatura.',
    input_schema: {
      type: 'object',
      properties: {
        competencia: { type: 'string', description: 'Competência da fatura no formato AAAA-MM. Ex: 2026-06. Se omitido, retorna a fatura atual + histórico.' },
      },
    },
  },
];
