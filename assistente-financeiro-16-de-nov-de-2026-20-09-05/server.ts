import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

const envNum = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:8b';
const OLLAMA_NUM_CTX = envNum('OLLAMA_NUM_CTX', 8192);
const OLLAMA_TEMPERATURE = envNum('OLLAMA_TEMPERATURE', 0.35);
const OLLAMA_THINK = process.env.OLLAMA_THINK === 'true';
const MAX_TENTATIVAS = Math.max(1, envNum('OLLAMA_MAX_TENTATIVAS', 2));
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface TransactionItem {
  id?: string;
  type: 'income' | 'expense' | string;
  amount: number;
  description: string;
  date: string;
  categoryId: string;
  createdAt?: number;
}

interface CategoryItem {
  id: string;
  name: string;
  type?: string;
  color?: string;
  isCustom?: boolean;
}

interface GoalItem {
  id?: string;
  kind: 'category_cap' | 'global_savings' | string;
  categoryId?: string;
  title?: string;
  targetAmount: number;
  manualSaved?: number | null;
}

interface FinancialDataPayload {
  transactions?: TransactionItem[];
  categories?: CategoryItem[];
  goals?: GoalItem[];
  today?: string;
}

type NivelRisco = 'Normal' | 'Alerta' | 'Crítico';

interface ComprometimentoRenda {
  percentual: number;
  percentualFormatado: string;
  risco: NivelRisco;
}

const brlFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const MONTH_NAMES_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const roundMoney = (val: unknown): number =>
  Math.round((Number(val) + Number.EPSILON) * 100) / 100;

function formatCurrency(val: unknown): string {
  return brlFormatter.format(Number(val) || 0).replace(/\s/g, ' ');
}

const formatPercent = (v: number): string => `${v.toFixed(1).replace('.', ',')}%`;

function calcularComprometimentoRenda(
  renda: number,
  despesas: number,
  gasto = 0
): ComprometimentoRenda {
  const totalComprometido = roundMoney(despesas + gasto);
  const percentual =
    renda > 0
      ? (totalComprometido / renda) * 100
      : totalComprometido > 0
        ? 100.1
        : 0;

  const risco: NivelRisco =
    percentual < 80 ? 'Normal' : percentual <= 100 ? 'Alerta' : 'Crítico';

  return {
    percentual,
    percentualFormatado: formatPercent(percentual),
    risco,
  };
}

function formatMonthLabel(ym: string): string {
  if (!ym || !ym.includes('-')) return ym;
  const [y, m] = ym.split('-');
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES_SHORT[idx] || m}/${y}`;
}

function getServerTodayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ------------------------------------------------------------------ */
/* LOG DE EXECUÇÃO                                                     */
/* ------------------------------------------------------------------ */

const LOG_DIR = path.resolve(__dirname, 'logs');

function logEvento(evento: Record<string, unknown>): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, 'chat-log.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...evento }) + '\n'
    );
  } catch (err) {
    console.error('Falha ao gravar log:', err);
  }
}

/* ------------------------------------------------------------------ */
/* FERRAMENTAS DETERMINÍSTICAS DO EXTRATO                              */
/* ------------------------------------------------------------------ */

function getCategoryById(id: string, categories: CategoryItem[]): CategoryItem {
  return (
    categories.find((c) => c.id === id) || {
      id: 'unknown',
      name: 'Sem categoria',
      type: 'both',
      color: '#64748B',
      isCustom: false,
    }
  );
}

function computeGoalStatus(
  goal: GoalItem,
  refMonth: string,
  transactions: TransactionItem[],
  categories: CategoryItem[]
) {
  if (goal.kind === 'category_cap') {
    const cat = getCategoryById(goal.categoryId || '', categories);
    const spent = roundMoney(
      transactions
        .filter(
          (tx) =>
            tx.type === 'expense' &&
            tx.categoryId === goal.categoryId &&
            String(tx.date || '').startsWith(refMonth)
        )
        .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0)
    );
    const target = Number(goal.targetAmount) || 0;
    const pctRaw = target > 0 ? (spent / target) * 100 : 0;
    const remaining = roundMoney(target - spent);

    let statusLabel = 'Dentro do orçamento';
    if (pctRaw > 100) statusLabel = 'Limite excedido';
    else if (pctRaw >= 80) statusLabel = 'Atenção: próximo do teto';

    return {
      title: `Teto · ${cat.name}`,
      subtitle: `Orçamento de ${formatMonthLabel(refMonth)}`,
      pctRaw,
      statusLabel,
      footerLeft: `Consumido: ${formatCurrency(spent)} de ${formatCurrency(target)}`,
      footerRight:
        remaining >= 0
          ? `Disponível: ${formatCurrency(remaining)}`
          : `Excedente: ${formatCurrency(Math.abs(remaining))}`,
    };
  }

  let totalIncome = 0;
  let totalExpense = 0;
  for (const tx of transactions) {
    if (tx.type === 'income') totalIncome += Number(tx.amount) || 0;
    else if (tx.type === 'expense') totalExpense += Number(tx.amount) || 0;
  }
  const globalBalance = roundMoney(totalIncome - totalExpense);
  const target = Number(goal.targetAmount) || 0;
  const usesManual = typeof goal.manualSaved === 'number' && !Number.isNaN(goal.manualSaved);
  const currentSaved = roundMoney(usesManual ? Number(goal.manualSaved) : Math.max(0, globalBalance));
  const pctRaw = target > 0 ? (currentSaved / target) * 100 : 0;
  const missing = roundMoney(Math.max(0, target - currentSaved));
  const reached = currentSaved >= target;

  return {
    title: goal.title || 'Meta de Economia Global',
    subtitle: usesManual ? 'Valor reservado manual' : 'Baseado no Saldo Total',
    pctRaw,
    statusLabel: reached ? 'Meta atingida' : 'Em andamento',
    footerLeft: `Acumulado: ${formatCurrency(currentSaved)} de ${formatCurrency(target)}`,
    footerRight: reached ? 'Objetivo concluído' : `Faltam ${formatCurrency(missing)}`,
  };
}

function executeDeterministicTool(
  name: string,
  args: Record<string, unknown>,
  financialData: FinancialDataPayload
): Record<string, unknown> {
  const transactions = Array.isArray(financialData.transactions) ? financialData.transactions : [];
  const categories = Array.isArray(financialData.categories) ? financialData.categories : [];
  const goals = Array.isArray(financialData.goals) ? financialData.goals : [];
  const todayISO =
    typeof financialData.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(financialData.today)
      ? financialData.today
      : getServerTodayISO();
  const currentMonth = todayISO.slice(0, 7);

  if (name === 'calcular_saldo_total') {
    let receitas = 0;
    let despesas = 0;
    for (const tx of transactions) {
      if (tx.type === 'income') receitas += Number(tx.amount) || 0;
      else if (tx.type === 'expense') despesas += Number(tx.amount) || 0;
    }
    receitas = roundMoney(receitas);
    despesas = roundMoney(despesas);
    const saldo = roundMoney(receitas - despesas);
    return {
      saldo_total: saldo,
      saldo_formatado: formatCurrency(saldo),
      receitas_totais: receitas,
      receitas_formatado: formatCurrency(receitas),
      despesas_totais: despesas,
      despesas_formatado: formatCurrency(despesas),
      total_lancamentos: transactions.length,
    };
  }

  if (name === 'somar_por_categoria') {
    const targetMonth =
      typeof args.mes_yyyy_mm === 'string' && args.mes_yyyy_mm.trim()
        ? args.mes_yyyy_mm.trim()
        : currentMonth;
    const tipo =
      typeof args.tipo === 'string' && args.tipo.trim() ? args.tipo.trim() : 'expense';
    const filtered = transactions.filter((tx) => {
      const matchDate = targetMonth === 'all' ? true : String(tx.date || '').startsWith(targetMonth);
      const matchType = tipo === 'all' ? true : tx.type === tipo;
      return matchDate && matchType;
    });

    const grouped = new Map<string, number>();
    let totalGeral = 0;
    for (const tx of filtered) {
      const val = Number(tx.amount) || 0;
      const catName = getCategoryById(tx.categoryId, categories).name;
      grouped.set(catName, roundMoney((grouped.get(catName) || 0) + val));
      totalGeral = roundMoney(totalGeral + val);
    }

    const ranking = Array.from(grouped.entries())
      .map(([categoria, total]) => ({
        categoria,
        total,
        total_formatado: formatCurrency(total),
        percentual: totalGeral > 0 ? formatPercent((total / totalGeral) * 100) : '0,0%',
      }))
      .sort((a, b) => b.total - a.total);

    return {
      periodo: targetMonth,
      tipo_filtrado: tipo,
      total_geral: totalGeral,
      total_geral_formatado: formatCurrency(totalGeral),
      quantidade_lancamentos: filtered.length,
      detalhamento_por_categoria: ranking,
    };
  }

  if (name === 'verificar_metas_financeiras') {
    const refMonth =
      typeof args.mes_yyyy_mm === 'string' && args.mes_yyyy_mm.trim()
        ? args.mes_yyyy_mm.trim()
        : currentMonth;
    if (goals.length === 0) {
      return { mensagem: 'Nenhuma meta financeira cadastrada.' };
    }
    const metas = goals.map((g) => {
      const info = computeGoalStatus(g, refMonth, transactions, categories);
      return {
        titulo: info.title,
        referencia: info.subtitle,
        situacao: info.statusLabel,
        percentual: formatPercent(info.pctRaw),
        resumo_valores: info.footerLeft,
        saldo_meta: info.footerRight,
      };
    });
    return { mes_referencia: refMonth, metas };
  }

  if (name === 'buscar_transacoes') {
    const termo = typeof args.termo === 'string' ? args.termo.trim().toLowerCase() : '';
    const dataInicio = typeof args.data_inicio === 'string' ? args.data_inicio.trim() : '';
    const dataFim = typeof args.data_fim === 'string' ? args.data_fim.trim() : '';
    const tipo = typeof args.tipo === 'string' ? args.tipo.trim() : '';

    const filtradas = transactions.filter((tx) => {
      if (tipo && tipo !== 'all' && tx.type !== tipo) return false;
      if (dataInicio && String(tx.date || '') < dataInicio) return false;
      if (dataFim && String(tx.date || '') > dataFim) return false;
      if (termo) {
        const desc = String(tx.description || '').toLowerCase();
        const cat = getCategoryById(tx.categoryId, categories).name.toLowerCase();
        if (!desc.includes(termo) && !cat.includes(termo)) return false;
      }
      return true;
    });

    const soma = roundMoney(filtradas.reduce((acc, tx) => acc + (Number(tx.amount) || 0), 0));
    const itens = filtradas
      .slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 15)
      .map((tx) => ({
        data: tx.date,
        tipo: tx.type === 'income' ? 'Receita' : 'Despesa',
        categoria: getCategoryById(tx.categoryId, categories).name,
        descricao: tx.description,
        valor: formatCurrency(tx.amount),
      }));

    return {
      total_encontrado: filtradas.length,
      soma_exata: soma,
      soma_formatada: formatCurrency(soma),
      amostra_recente: itens,
    };
  }

  if (name === 'comparar_ultimos_meses') {
    const qtd = Math.min(Math.max(Number(args.quantidade_meses) || 6, 1), 24);
    const [y, m] = todayISO.slice(0, 7).split('-').map(Number);
    const meses = [];
    for (let i = qtd - 1; i >= 0; i--) {
      const d = new Date(y, m - 1 - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const txsMes = transactions.filter((t) => String(t.date || '').startsWith(ym));
      const receitas = roundMoney(
        txsMes.filter((t) => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0)
      );
      const despesas = roundMoney(
        txsMes.filter((t) => t.type === 'expense').reduce((s, t) => s + (Number(t.amount) || 0), 0)
      );
      meses.push({
        mes: ym,
        receitas: formatCurrency(receitas),
        despesas: formatCurrency(despesas),
        balanco_mensal: formatCurrency(roundMoney(receitas - despesas)),
      });
    }
    return { comparativo_mensal: meses };
  }

  return { erro: `Ferramenta desconhecida: ${name}` };
}

function buildDeterministicSnapshot(financialData: FinancialDataPayload, todayISO: string) {
  const currentMonth = todayISO.slice(0, 7);
  const despesasMes = executeDeterministicTool(
    'somar_por_categoria',
    { mes_yyyy_mm: currentMonth, tipo: 'expense' },
    financialData
  );
  const receitasMes = executeDeterministicTool(
    'somar_por_categoria',
    { mes_yyyy_mm: currentMonth, tipo: 'income' },
    financialData
  );
  const recVal = Number(receitasMes.total_geral) || 0;
  const despVal = Number(despesasMes.total_geral) || 0;
  const saldoMes = roundMoney(recVal - despVal);
  const comprometimento = calcularComprometimentoRenda(recVal, despVal);

  return {
    resumo_mes_atual: {
      mes: currentMonth,
      receitas_formatado: formatCurrency(recVal),
      despesas_formatado: formatCurrency(despVal),
      saldo_mes_formatado: formatCurrency(saldoMes),
      percentual_renda_comprometido: comprometimento.percentualFormatado,
      risco_comprometimento: comprometimento.risco,
    },
    saldo_total: executeDeterministicTool('calcular_saldo_total', {}, financialData),
    despesas_mes_atual: despesasMes,
    receitas_mes_atual: receitasMes,
    metas: executeDeterministicTool(
      'verificar_metas_financeiras',
      { mes_yyyy_mm: currentMonth },
      financialData
    ),
    lancamentos_recentes: executeDeterministicTool('buscar_transacoes', {}, financialData),
    comparativo_6_meses: executeDeterministicTool(
      'comparar_ultimos_meses',
      { quantidade_meses: 6 },
      financialData
    ),
  };
}

/* ================================================================== */
/* INSTRUÇÕES PARA O COMPORTAMENTO DO MODELO                                     */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* TIPOS DO FLUXO                                                      */
/* ------------------------------------------------------------------ */

type TipoItem = 'renda' | 'fixa' | 'variavel';
type Intencao = 'saudacao' | 'dados' | 'sem_mais_dados' | 'avaliar_compra' | 'pergunta' | 'outro';

interface ItemFinanceiro {
  descricao: string;
  valor: number | null;
  tipo: TipoItem;
}

interface CompraExtraida {
  descricao: string;
  valor: number | null;
  parcelas: number | null;
  formaInformada: boolean;
}

interface Extracao {
  itens: ItemFinanceiro[];
  compra: CompraExtraida | null;
  intencao: Intencao;
}

interface Perfil {
  renda?: number;
  fixos: ItemFinanceiro[];
  variaveis: ItemFinanceiro[];
  ignorados: string[]; // itens que o usuário não soube informar o valor
}

interface Gasto {
  valor: number;
  parcelas: number;
  descricao?: string;
}

type Fase =
  | 'APRESENTACAO'
  | 'COLETA'
  | 'ESCLARECIMENTO' // P06 / Passo 5: pergunta maiêutica pontual
  | 'CONFIRMACAO' // "tem mais alguma despesa?" antes de fechar o perfil
  | 'FECHAMENTO'
  | 'CONSULTORIA'
  | 'RECOMENDACAO'; // P02–P05 + Passo 11

type AlvoColeta = 'renda' | 'fixos' | 'variaveis' | 'valores';

interface Pendencia {
  chave: string;
  tipo: 'sem_valor' | 'duplicidade' | 'renda_multipla' | 'compra_sem_valor' | 'compra_sem_forma';
  item: string;
  detalhe: string;
}

interface Decisao {
  fase: Fase;
  perfil: Perfil;
  ultimaMsg: string;
  apresentar: boolean;
  intencao: Intencao;
  extracaoFalhou: boolean;
  alvoColeta?: AlvoColeta;
  pendencia?: Pendencia;
  gasto?: Gasto;
}

const MARCADOR_FECHAMENTO = /resumo do seu m[eê]s/i;
const MARCADOR_VEREDITO = /veredito/i;
const REGEX_CONFIRMACAO = /mais alguma despesa/i;

const REGEX_INTENCAO_COMPRA =
  /\b(comprar|compra|gastar|gasto|avaliar|posso pagar|vale a pena|parcelar|parcelado|[àa]\s*vista|t[eê]nis|celular|notebook|placa de v[ií]deo|fone|roupa|viagem|presente|tv|videogame)\b/i;

const somaMoney = (arr: number[]): number => roundMoney(arr.reduce((s, n) => s + n, 0));

const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const radicais = (s: string): string[] =>
  normalizar(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, 5));

const mencionaTermo = (texto: string, termo: string): boolean => {
  const t = normalizar(texto);
  return radicais(termo).some((r) => t.includes(r));
};

/* ------------------------------------------------------------------ */
/* EXTRAÇÃO ESTRUTURADA (LLM) + VALIDAÇÃO DETERMINÍSTICA               */
/* O LLM só LÊ o que o usuário escreveu. Cada número devolvido por ele  */
/* precisa existir literalmente na fala do usuário; senão é descartado. */
/* ------------------------------------------------------------------ */

const INTENCOES: Intencao[] = ['saudacao', 'dados', 'sem_mais_dados', 'avaliar_compra', 'pergunta', 'outro'];

const paraNumeroOuNull = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function promptExtracao(conversa: string): string {
  return [
    'Você é um extrator de dados financeiros. Leia a CONVERSA e devolva SOMENTE um JSON válido (sem markdown, sem comentários, sem texto fora do JSON).',
    '',
    'ESQUEMA:',
    '{"itens":[{"descricao":"string","valor":numero|null,"tipo":"renda"|"fixa"|"variavel"}],',
    ' "compra":{"descricao":"string","valor":numero|null,"parcelas":numero|null,"forma_informada":true|false}|null,',
    ' "intencao":"saudacao"|"dados"|"sem_mais_dados"|"avaliar_compra"|"pergunta"|"outro"}',
    '',
    'REGRAS:',
    '- Devolva o JSON compacto, em uma única linha, sem explicações. Números sempre com ponto decimal (44.90), nunca com vírgula.',
    '- Extraia dados SOMENTE do que o USUÁRIO escreveu. Falas do ASSISTENTE servem apenas para entender a que o usuário está respondendo.',
    '- Copie o valor exatamente como o usuário escreveu (1.200,50 vira 1200.5). NUNCA some, subtraia, estime ou invente. Se o usuário citou um item mas não disse o valor, use valor null.',
    '- Faixa de valores (ex.: "entre 500 e 700"): use o maior valor.',
    '- tipo "renda": dinheiro que entra por mês. Use um item por fonte de renda. tipo "fixa": contas recorrentes (aluguel, internet, água, energia, condomínio, assinaturas, streaming, plano). tipo "variavel": gasto do dia a dia (alimentação, mercado, delivery, transporte, lazer).',
    '- Categoria em que o usuário disse que não gasta (ex.: "não gasto com transporte"): não crie item. Se ele disser que não tem NENHUM gasto variável, crie um item variavel com descricao "nenhum gasto variável" e valor 0.',
    '- Se o usuário citou o mesmo item duas vezes com valores diferentes e ainda NÃO esclareceu, mantenha os dois itens com a mesma descricao.',
    '- Respostas do usuário a perguntas do assistente completam ou corrigem itens anteriores: devolva a lista FINAL e consolidada, já aplicando essas correções.',
    '- compra: a compra MAIS RECENTE que o usuário quer avaliar, ou null. forma_informada só é true se o usuário disse se é à vista ou parcelado. À vista = parcelas 1. Sem forma informada = parcelas null.',
    '- intencao da ÚLTIMA mensagem do usuário: saudacao (só cumprimenta), dados (informou ou corrigiu valores/itens), sem_mais_dados (diz que não há mais nada ou pode seguir), avaliar_compra (quer avaliar uma compra), pergunta (pede dicas ou tem dúvida), outro.',
    '',
    'CONVERSA:',
    conversa,
    '',
    'JSON:',
  ].join('\n');
}

function parseExtracao(texto: string): Extracao | null {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const json = texto
      .slice(ini, fim + 1)
      .replace(/[“”]/g, '"')
      .replace(/("(?:valor|parcelas)"\s*:\s*)(\d+),(\d{1,2})(?=\s*[,}\]])/g, '$1$2.$3') // 44,90 -> 44.90
      .replace(/,\s*([}\]])/g, '$1'); // vírgula sobrando antes de } ou ]
    const j = JSON.parse(json) as Record<string, unknown>;
    const brutos = Array.isArray(j.itens) ? (j.itens as Array<Record<string, unknown>>) : [];
    const itens: ItemFinanceiro[] = [];
    for (const it of brutos) {
      const tipo = it?.tipo;
      if (tipo !== 'renda' && tipo !== 'fixa' && tipo !== 'variavel') continue;
      const descricao = String(it.descricao ?? '').trim();
      if (!descricao) continue;
      const valor = paraNumeroOuNull(it.valor);
      if (valor !== null && valor < 0) continue;
      itens.push({ descricao, valor, tipo });
    }

    let compra: CompraExtraida | null = null;
    const c = j.compra as Record<string, unknown> | null | undefined;
    if (c && typeof c === 'object') {
      const p = paraNumeroOuNull(c.parcelas);
      compra = {
        descricao: String(c.descricao ?? 'compra').trim() || 'compra',
        valor: paraNumeroOuNull(c.valor),
        parcelas: p !== null && p >= 1 && p <= 60 ? Math.round(p) : null,
        formaInformada: c.forma_informada === true,
      };
    }

    const intencao = INTENCOES.includes(j.intencao as Intencao) ? (j.intencao as Intencao) : 'outro';
    return { itens, compra, intencao };
  } catch {
    return null;
  }
}

const chaveValor = (n: number): string => {
  const [i, d] = n.toFixed(2).split('.');
  return `${i},${d}`;
};

function valoresInventados(ext: Extracao, textoUsuario: string): string[] {
  const permitidos = permitidosDoUsuario(textoUsuario);
  const ruins: string[] = [];
  for (const it of ext.itens) {
    if (it.valor !== null && it.valor !== 0 && !permitidos.has(chaveValor(it.valor))) {
      ruins.push(`${it.descricao}=${it.valor}`);
    }
  }
  if (ext.compra && ext.compra.valor !== null && !permitidos.has(chaveValor(ext.compra.valor))) {
    ruins.push(`compra=${ext.compra.valor}`);
  }
  return ruins;
}

// Último recurso: um valor que o usuário não escreveu vira "sem valor" e o sistema pergunta.
function sanitizar(ext: Extracao, textoUsuario: string): Extracao {
  const permitidos = permitidosDoUsuario(textoUsuario);
  const ok = (v: number | null) => v === null || v === 0 || permitidos.has(chaveValor(v));
  return {
    ...ext,
    itens: ext.itens.map((it) => (ok(it.valor) ? it : { ...it, valor: null })),
    compra: ext.compra ? { ...ext.compra, valor: ok(ext.compra.valor) ? ext.compra.valor : null } : null,
  };
}

async function extrairEstruturado(messages: ChatMessage[], signal?: AbortSignal): Promise<Extracao | null> {
  const textoUsuario = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const conversa = messages
    .slice(-24)
    .map((m) => `${m.role === 'assistant' ? 'ASSISTENTE' : 'USUÁRIO'}: ${m.content}`)
    .join('\n');
  const base = promptExtracao(conversa);
  let prompt = base;
  let ultimo: Extracao | null = null;

  for (let i = 0; i < 2; i++) {
    const { raw, texto } = await callOllama(prompt, { temperature: 0, maxTokens: 4096, signal });
    const ext = parseExtracao(texto);
    const problemas: string[] = [];
    if (!ext) problemas.push('JSON inválido');
    else {
      ultimo = ext;
      const ruins = valoresInventados(ext, textoUsuario);
      if (ruins.length > 0) problemas.push(`valores que o usuário não escreveu: ${ruins.join(', ')}`);
    }
    logEvento({ tipo: 'extracao', tentativa: i + 1, ok: problemas.length === 0, problemas, resposta_bruta: raw });
    if (ext && problemas.length === 0) return ext;
    prompt = `${base}\n\nCORREÇÃO: sua resposta anterior foi recusada (${problemas.join('; ')}). Devolva apenas o JSON, copiando os valores exatamente como o usuário escreveu e usando null quando faltar valor.`;
  }
  return ultimo ? sanitizar(ultimo, textoUsuario) : null;
}

/* ------------------------------------------------------------------ */
/* CONSOLIDAÇÃO DO PERFIL E DETECÇÃO DE PENDÊNCIAS (P06)               */
/* ------------------------------------------------------------------ */

// Já perguntamos sobre este termo e o usuário já respondeu? (evita loop infinito de perguntas)
function jaPerguntado(messages: ChatMessage[], termo: string, extraRegex?: RegExp): boolean {
  return messages.some(
    (m, i) =>
      m.role === 'assistant' &&
      i < messages.length - 1 &&
      m.content.includes('?') &&
      mencionaTermo(m.content, termo) &&
      (!extraRegex || extraRegex.test(m.content))
  );
}

function consolidar(ext: Extracao, messages: ChatMessage[]): { perfil: Perfil; pendencias: Pendencia[] } {
  const pendencias: Pendencia[] = [];
  const ignorados: string[] = [];
  const validos: ItemFinanceiro[] = [];

  for (const it of ext.itens) {
    if (it.valor === null) {
      if (jaPerguntado(messages, it.descricao)) ignorados.push(it.descricao);
      else {
        pendencias.push({
          chave: `sem_valor:${normalizar(it.descricao)}`,
          tipo: 'sem_valor',
          item: it.descricao,
          detalhe: `O usuário citou "${it.descricao}", mas não informou o valor.`,
        });
      }
      continue;
    }
    validos.push(it);
  }

  // Mesma conta citada mais de uma vez (ex.: "internet" duas vezes com valores diferentes)
  const grupos = new Map<string, ItemFinanceiro[]>();
  for (const it of validos.filter((i) => i.tipo !== 'renda')) {
    const k = `${it.tipo}:${normalizar(it.descricao)}`;
    grupos.set(k, [...(grupos.get(k) ?? []), it]);
  }
  Array.from(grupos.entries()).forEach(([k, lista]) => {
    if (lista.length > 1 && !jaPerguntado(messages, lista[0].descricao)) {
      pendencias.push({
        chave: `duplicidade:${k}`,
        tipo: 'duplicidade',
        item: lista[0].descricao,
        detalhe: `O usuário citou "${lista[0].descricao}" mais de uma vez, com os valores ${lista
          .map((i) => formatCurrency(i.valor))
          .join(' e ')}.`,
      });
    }
  });

  const rendas = validos.filter((i) => i.tipo === 'renda');
  let renda: number | undefined;
  if (rendas.length === 1) renda = rendas[0].valor as number;
  else if (rendas.length > 1) {
    const ref = rendas[rendas.length - 1];
    if (jaPerguntado(messages, ref.descricao)) renda = ref.valor as number;
    else {
      pendencias.push({
        chave: 'renda_multipla',
        tipo: 'renda_multipla',
        item: ref.descricao,
        detalhe: `O usuário citou mais de um valor de renda (${rendas
          .map((r) => `${r.descricao}: ${formatCurrency(r.valor)}`)
          .join('; ')}). É preciso saber qual é o valor total que entra por mês.`,
      });
    }
  }

  const perfil: Perfil = {
    renda,
    fixos: validos.filter((i) => i.tipo === 'fixa'),
    variaveis: validos.filter((i) => i.tipo === 'variavel'),
    ignorados,
  };
  return { perfil, pendencias };
}

function compraPronta(
  compra: CompraExtraida | null,
  messages: ChatMessage[]
): { gasto?: Gasto; pendencia?: Pendencia } {
  if (!compra) return {};
  const nome = compra.descricao || 'compra';

  if (compra.valor === null || compra.valor <= 0) {
    if (jaPerguntado(messages, nome, /valor|quanto|custa/i)) return {};
    return {
      pendencia: {
        chave: 'compra_sem_valor',
        tipo: 'compra_sem_valor',
        item: nome,
        detalhe: `O usuário quer avaliar a compra de "${nome}", mas não disse o valor.`,
      },
    };
  }

  if (!compra.formaInformada || compra.parcelas === null) {
    if (jaPerguntado(messages, nome, /vista|parcel/i)) {
      return { gasto: { valor: compra.valor, parcelas: 1, descricao: nome } }; // já perguntamos: assume à vista
    }
    return {
      pendencia: {
        chave: 'compra_sem_forma',
        tipo: 'compra_sem_forma',
        item: nome,
        detalhe: `O usuário quer avaliar a compra de "${nome}" (${formatCurrency(compra.valor)}), mas não disse se será à vista ou parcelado.`,
      },
    };
  }
  return { gasto: { valor: compra.valor, parcelas: compra.parcelas, descricao: nome } };
}

/* ------------------------------------------------------------------ */
/* DECISÃO DE FASE (máquina de estados — fluxograma P01..P06)          */
/* ------------------------------------------------------------------ */

async function decidirFluxo(messages: ChatMessage[], signal?: AbortSignal): Promise<Decisao> {
  const userMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const ultimaMsg = userMsgs[userMsgs.length - 1] ?? '';
  const apresentar = !messages.some((m) => m.role === 'assistant' && /\bNexo\b/i.test(m.content));

  const extracao = await extrairEstruturado(messages, signal);
  const ext: Extracao = extracao ?? { itens: [], compra: null, intencao: 'outro' };
  const { perfil, pendencias } = consolidar(ext, messages);

  const mk = (fase: Fase, extra: Partial<Decisao> = {}): Decisao => ({
    fase,
    perfil,
    ultimaMsg,
    apresentar,
    intencao: ext.intencao,
    extracaoFalhou: extracao === null,
    ...extra,
  });

  if (extracao === null) {
    const temNumero = /\d/.test(userMsgs.join(' '));
    return mk(temNumero ? 'COLETA' : apresentar ? 'APRESENTACAO' : 'COLETA', { alvoColeta: temNumero ? 'valores' : 'renda' });
  }

  const fechado = messages.some(
    (m) => m.role === 'assistant' && (MARCADOR_FECHAMENTO.test(m.content) || MARCADOR_VEREDITO.test(m.content))
  );
  const ultimoAssistente = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  const aguardandoConfirmacao = REGEX_CONFIRMACAO.test(ultimoAssistente);

  const semDados = perfil.renda === undefined && perfil.fixos.length === 0 && perfil.variaveis.length === 0;
  if (semDados && pendencias.length === 0) {
    return mk(apresentar ? 'APRESENTACAO' : 'COLETA', { alvoColeta: 'renda' });
  }

  // P06: dado ambíguo ou faltando → pergunta maiêutica, e volta ao P06 na próxima mensagem
  if (pendencias.length > 0) return mk('ESCLARECIMENTO', { pendencia: pendencias[0] });

  const falta: AlvoColeta | undefined =
    perfil.renda === undefined ? 'renda' : perfil.fixos.length === 0 ? 'fixos' : perfil.variaveis.length === 0 ? 'variaveis' : undefined;
  if (falta) return mk('COLETA', { alvoColeta: falta });

  const { gasto, pendencia: pendCompra } = compraPronta(ext.compra, messages);

  if (!fechado) {
    // Perfil completo, mas ainda não perguntamos (ou o usuário acrescentou algo): confirma antes de fechar
    if (!(aguardandoConfirmacao && ext.intencao !== 'dados')) return mk('CONFIRMACAO');
    if (pendCompra) return mk('ESCLARECIMENTO', { pendencia: pendCompra });
    if (gasto) return mk('RECOMENDACAO', { gasto });
    return mk('FECHAMENTO');
  }

  // Perfil já fechado (Passo 12: o usuário continua, corrige ou reinicia o fluxo)
  if (ext.intencao === 'dados') return mk('FECHAMENTO');
  if (ext.intencao === 'avaliar_compra') {
    if (pendCompra) return mk('ESCLARECIMENTO', { pendencia: pendCompra });
    if (gasto) return mk('RECOMENDACAO', { gasto });
  }
  return mk('CONSULTORIA', { gasto });
}

/* ------------------------------------------------------------------ */
/* CÁLCULOS REALIZADOS SEMPRE PELO PYTHON (TypeScript só como rede de segurança) */
/* ------------------------------------------------------------------ */

interface BaseFinanceira {
  renda: number;
  totalFixos: number;
  totalVariaveis: number;
  totalDespesas: number;
  saldoLivre: number;
  percentualFormatado: string;
  risco: NivelRisco;
}

interface ResultadoBase {
  base: BaseFinanceira;
  py: Record<string, unknown> | null;
}

const lerNumero = (obj: Record<string, unknown> | null, chave: string): number | undefined => {
  const v = obj ? obj[chave] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

const lerObjeto = (obj: Record<string, unknown> | null, chave: string): Record<string, unknown> | null => {
  const v = obj ? obj[chave] : undefined;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
};

function executarPython(payload: Record<string, unknown>): Record<string, unknown> | null {
  const venvPython = path.resolve(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const pythonBin = process.env.PYTHON_BIN || (fs.existsSync(venvPython) ? venvPython : 'python');
  const scriptPath = path.resolve(__dirname, '..', 'backend', 'financeiro', 'calcular_conversa.py');

  try {
    const stdout = execFileSync(pythonBin, [scriptPath], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    console.error('Erro ao executar calcular_conversa.py:', err);
    return null;
  }
}

function obterBase(perfil: Perfil, gasto?: Gasto): ResultadoBase {
  const renda = perfil.renda ?? 0;
  const fixos = perfil.fixos.map((i) => i.valor ?? 0);
  const variaveis = perfil.variaveis.map((i) => i.valor ?? 0);

  const payload: Record<string, unknown> = { renda, fixos, variaveis };
  if (gasto) {
    payload.valor_gasto = gasto.valor;
    if (gasto.parcelas > 1) payload.parcelas = gasto.parcelas;
  }
  const py = executarPython(payload);
  if (py) console.log('[PYTHON CALCULO]', JSON.stringify(py));

  // Rede de segurança: só é usada para campos que o Python não devolveu
  const totalFixosTs = somaMoney(fixos);
  const totalVariaveisTs = somaMoney(variaveis);
  const rendaFinal = lerNumero(py, 'renda') ?? renda;
  const totalFixos = lerNumero(py, 'total_fixos') ?? totalFixosTs;
  const totalVariaveis = lerNumero(py, 'total_variaveis') ?? totalVariaveisTs;
  const totalDespesas = lerNumero(py, 'total_despesas') ?? roundMoney(totalFixosTs + totalVariaveisTs);
  const compTs = calcularComprometimentoRenda(rendaFinal, totalDespesas);
  const saldoLivre = lerNumero(py, 'saldo_livre') ?? roundMoney(rendaFinal - totalDespesas);
  const pctPy = lerNumero(py, 'percentual_comprometido');
  const riscoPy = typeof py?.risco === 'string' ? py.risco : undefined;
  const risco: NivelRisco =
    riscoPy === 'Normal' || riscoPy === 'Alerta' || riscoPy === 'Crítico' ? riscoPy : compTs.risco;

  if (py && (lerNumero(py, 'saldo_livre') === undefined || pctPy === undefined)) {
    logEvento({ tipo: 'python_sem_campos_base', faltando: ['saldo_livre', 'percentual_comprometido'].filter((k) => lerNumero(py, k) === undefined) });
  }
  if (Math.abs(totalDespesas - roundMoney(totalFixosTs + totalVariaveisTs)) > 0.005 || Math.abs(rendaFinal - renda) > 0.005) {
    logEvento({ tipo: 'divergencia_python_ts', python: { renda: rendaFinal, total_despesas: totalDespesas }, ts: { renda, total_despesas: roundMoney(totalFixosTs + totalVariaveisTs) } });
  }

  return {
    py,
    base: {
      renda: rendaFinal,
      totalFixos,
      totalVariaveis,
      totalDespesas,
      saldoLivre,
      percentualFormatado: pctPy !== undefined ? formatPercent(pctPy) : compTs.percentualFormatado,
      risco,
    },
  };
}

interface Cenario {
  gasto: Gasto;
  cabe: boolean;
  nivel: NivelRisco;
  veredito: string;
  parcelado: boolean;
  v: Record<string, string>;
  linhasDados: string;
}

function montarCenario(base: BaseFinanceira, gasto: Gasto, py: Record<string, unknown> | null): Cenario {
  const cen = lerObjeto(py, 'cenario');
  const parcelado = gasto.parcelas > 1;

  // Rede de segurança em TS (só entra se o Python não devolver o campo em py.cenario)
  const tsValorNoMes = parcelado ? roundMoney(gasto.valor / gasto.parcelas) : gasto.valor;
  const tsSaldoDepois = roundMoney(base.saldoLivre - tsValorNoMes);
  const tsComp = calcularComprometimentoRenda(base.renda, base.totalDespesas, tsValorNoMes);

  const valorNoMes = lerNumero(cen, 'valor_no_mes') ?? tsValorNoMes;
  const saldoDepois = lerNumero(cen, 'saldo_depois') ?? tsSaldoDepois;
  const percentual = lerNumero(cen, 'percentual_comprometido') ?? tsComp.percentual;
  const riscoPy = cen && typeof cen.risco === 'string' ? cen.risco : undefined;
  const nivel: NivelRisco =
    riscoPy === 'Normal' || riscoPy === 'Alerta' || riscoPy === 'Crítico' ? riscoPy : tsComp.risco;
  const cabe = saldoDepois >= 0;
  const falta = lerNumero(cen, 'falta') ?? (cabe ? 0 : roundMoney(-saldoDepois));
  const semanal = lerNumero(cen, 'valor_semanal') ?? roundMoney((cabe ? saldoDepois : falta) / 4);

  const faltouNoPython = ['valor_no_mes', 'saldo_depois', 'percentual_comprometido', 'falta', 'valor_semanal'].filter(
    (k) => lerNumero(cen, k) === undefined
  );
  if (faltouNoPython.length > 0) logEvento({ tipo: 'python_sem_campos_cenario', faltando: faltouNoPython });

  const veredito = !cabe ? 'NÃO CABE' : nivel === 'Alerta' ? 'CABE, MAS COM POUCA FOLGA' : 'CABE';

  const v: Record<string, string> = {
    renda: formatCurrency(base.renda),
    despesas: formatCurrency(base.totalDespesas),
    saldo_antes: formatCurrency(base.saldoLivre),
    gasto: formatCurrency(gasto.valor),
    forma: parcelado ? `${gasto.parcelas}x de ${formatCurrency(valorNoMes)}` : 'à vista',
    impacto_mes: formatCurrency(valorNoMes),
    saldo_depois: formatCurrency(saldoDepois),
    pct_depois: formatPercent(percentual),
    risco: nivel,
    falta: formatCurrency(falta),
    semanal: formatCurrency(semanal),
  };

  const linhas = [
    `Renda mensal: ${v.renda}`,
    `Despesas totais do mês: ${v.despesas}`,
    `Saldo atual: ${v.saldo_antes}`,
    `Valor do gasto: ${v.gasto} (${v.forma})`,
    `Impacto neste mês${parcelado ? ' (1ª parcela)' : ''}: ${v.impacto_mes}`,
    `Saldo final: ${v.saldo_depois}`,
    `Comprometimento da renda após o gasto: ${v.pct_depois} (Risco: ${nivel})`,
    `Veredito: ${veredito}`,
    cabe
      ? `Valor semanal que pode guardar da folga: ${v.semanal}`
      : `Quanto falta: ${v.falta}\nValor semanal para juntar o que falta: ${v.semanal}`,
  ];

  return { gasto, cabe, nivel, veredito, parcelado, v, linhasDados: linhas.join('\n') };
}

// P04: caminhos independentes, todos calculados pelo Python
function gerarCaminhos(perfil: Perfil, gasto: Gasto): { base: BaseFinanceira; principal: Cenario; alternativas: Cenario[] } {
  const { base, py } = obterBase(perfil, gasto);
  const principal = montarCenario(base, gasto, py);

  const formas = gasto.parcelas === 1 ? [6, 12] : gasto.parcelas <= 6 ? [1, 12] : [1, 6];
  const alternativas = formas.map((n) => {
    const g: Gasto = { ...gasto, parcelas: n };
    const r = obterBase(perfil, g);
    return montarCenario(r.base, g, r.py);
  });
  return { base, principal, alternativas };
}

const resumoCaminho = (c: Cenario): string =>
  `Opção ${c.v.forma}: impacto no mês ${c.v.impacto_mes}; saldo final ${c.v.saldo_depois}; ${c.v.pct_depois} da renda comprometida (Risco: ${c.nivel}); veredito: ${c.veredito}`;

/* ------------------------------------------------------------------ */
/* CONTEXTO PARA OS PROMPTS (somente dados vindos do usuário / Python) */
/* ------------------------------------------------------------------ */

function linhasItens(p: Perfil): string[] {
  const l: string[] = [];
  if (p.renda !== undefined) l.push(`Renda mensal líquida informada: ${formatCurrency(p.renda)}`);
  p.fixos.forEach((i) => l.push(`Conta fixa — ${i.descricao}: ${formatCurrency(i.valor)}`));
  [...p.variaveis]
    .sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0))
    .forEach((i) => l.push(`Gasto variável — ${i.descricao}: ${formatCurrency(i.valor)}`));
  if (p.ignorados.length > 0) l.push(`Sem valor informado (ficou fora do cálculo): ${p.ignorados.join(', ')}`);
  return l;
}

const linhasBase = (b: BaseFinanceira): string[] => [
  `Renda mensal líquida: ${formatCurrency(b.renda)}`,
  `Total de contas fixas: ${formatCurrency(b.totalFixos)}`,
  `Total de gastos variáveis: ${formatCurrency(b.totalVariaveis)}`,
  `Total de despesas: ${formatCurrency(b.totalDespesas)}`,
  `Saldo livre atual: ${formatCurrency(b.saldoLivre)}`,
  `Comprometimento da renda: ${b.percentualFormatado} (Risco: ${b.risco})`,
];

const permitidosPerfil = (p: Perfil, extra: string): Set<string> => permitidosDe(linhasItens(p).join(' '), extra);

/* ------------------------------------------------------------------ */
/* PROMPTS                                                             */
/* ------------------------------------------------------------------ */

const PERSONA = [
  'Você é o Nexo, um consultor de educação financeira amigável, cordial, empático e acolhedor para jovens adultos.',
  'Fale em português do Brasil, de forma natural e humana, sem julgamentos e sem frases de roteiro: reaja ao que a pessoa realmente escreveu.',
];

const REGRAS_GERAIS = [
  '- Nunca invente, estime nem calcule números. Use apenas os valores do CONTEXTO, copiados exatamente (com R$ e %).',
  '- Não some, subtraia nem compare numericamente categorias entre si; compare apenas de forma qualitativa (maior, menor, pesa mais).',
  '- Faça no máximo UMA pergunta por resposta.',
  '- Não mostre raciocínio interno nem use termos técnicos (JSON, prompt, sistema, Python).',
];

function promptConversa(p: {
  apresentar: boolean;
  tarefa: string[];
  contexto?: string[];
  historico: ChatMessage[];
}): string {
  const historico = p.historico
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Nexo' : 'Usuário'}: ${m.content}`)
    .join('\n');
  return [
    ...PERSONA,
    p.apresentar
      ? 'APRESENTAÇÃO: esta é a sua primeira resposta. Comece se apresentando pelo nome (ex.: "Sou o Nexo") de forma calorosa, em uma frase, antes de seguir a tarefa.'
      : 'Você já se apresentou antes; não se apresente de novo.',
    '',
    'TAREFA:',
    ...p.tarefa,
    ...(p.contexto && p.contexto.length > 0
      ? ['', 'CONTEXTO CONFIRMADO (números exatos):', ...p.contexto.map((c) => `- ${c}`)]
      : []),
    '',
    'REGRAS:',
    ...REGRAS_GERAIS,
    '',
    'CONVERSA RECENTE:',
    historico,
    '',
    'Responda agora à última mensagem do usuário como o Nexo.',
  ].join('\n');
}

const ALVOS_COLETA: Record<AlvoColeta, string> = {
  renda: 'a renda mensal líquida (o valor que cai na conta por mês)',
  fixos: 'as contas fixas do mês (aluguel, internet, água, energia, assinaturas e streamings etc.) com o valor de cada uma',
  variaveis: 'quanto costuma gastar por mês com o dia a dia (mercado, alimentação, delivery, transporte, lazer)',
  valores: 'os valores em números (por exemplo "600 de aluguel"), pois não consegui identificar com segurança os valores da última mensagem',
};

const FALLBACK_COLETA: Record<AlvoColeta, string> = {
  renda: 'Oi! Eu sou o Nexo, seu parceiro de organização financeira. Para começarmos, qual é a sua renda mensal líquida (o valor que cai na conta por mês)?',
  fixos: 'Anotado! Agora me conta: quanto você paga por mês em contas fixas (aluguel, internet, água, energia, assinaturas)?',
  variaveis: 'Perfeito! E quanto você costuma gastar por mês com o dia a dia (mercado, alimentação, delivery, transporte e lazer)?',
  valores: 'Não consegui identificar bem os valores. Pode me mandar os números de novo, por exemplo "600 de aluguel, 160 de internet"?',
};

function tarefaPendencia(p: Pendencia): string[] {
  const base = [
    'Faça UMA pergunta curta, gentil e específica (estilo maiêutico: ajude o usuário a perceber e esclarecer o ponto) sobre este ponto, e nada além dele:',
    `PONTO EM ABERTO: ${p.detalhe}`,
    'Não assuma nem escolha valores por conta própria. Mencione o item pelo nome.',
  ];
  const porTipo: Record<Pendencia['tipo'], string> = {
    sem_valor: 'Pergunte quanto ele paga nesse item (aceite um valor aproximado ou o total do grupo; se não souber, diga que tudo bem).',
    duplicidade: 'Pergunte se são duas contas diferentes ou se foi repetição/correção, e qual valor vale.',
    renda_multipla: 'Pergunte qual é o valor total líquido que entra por mês.',
    compra_sem_valor: 'Pergunte o valor total da compra.',
    compra_sem_forma: 'Pergunte se pretende pagar à vista ou parcelado (e, se parcelado, em quantas vezes e se é sem juros).',
  };
  return [...base, porTipo[p.tipo]];
}

function promptRecomendacao(p: {
  apresentar: boolean;
  principal: Cenario;
  alternativas: Cenario[];
  perfil: Perfil;
  base: BaseFinanceira;
  historico: ChatMessage[];
}): string {
  const historico = p.historico
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Nexo' : 'Usuário'}: ${m.content}`)
    .join('\n');
  const objetivo = p.principal.gasto.descricao || 'a compra';
  return [
    ...PERSONA,
    p.apresentar
      ? 'Esta é a sua primeira resposta: apresente-se pelo nome em uma frase antes de começar.'
      : 'Você já se apresentou; não se apresente de novo.',
    '',
    `OBJETIVO DO USUÁRIO: avaliar a compra de "${objetivo}".`,
    '',
    'CÁLCULOS FEITOS PELO PROGRAMA (únicos números que você pode citar):',
    p.principal.linhasDados,
    '',
    'OUTROS CAMINHOS CALCULADOS (hipóteses; valem apenas se a loja realmente oferecer essa forma sem juros):',
    ...p.alternativas.map((c) => `- ${resumoCaminho(c)}`),
    '',
    'PERFIL REAL DO USUÁRIO (maiores gastos variáveis primeiro):',
    ...linhasItens(p.perfil).map((l) => `- ${l}`),
    ...linhasBase(p.base).map((l) => `- ${l}`),
    '',
    'ROTEIRO INTERNO (não mostre): (1) entenda o que ele quer e quanto sobra; (2) leia o impacto da forma de pagamento escolhida; (3) compare com os outros caminhos e com as categorias reais do perfil; (4) confira se o veredito bate com os cálculos e se a dica usa só números permitidos.',
    '',
    'COMO RESPONDER (texto natural, até ~10 frases, sem copiar fórmulas prontas):',
    `- Abra com uma linha "**Veredito:**" e o veredito: ${p.principal.veredito}.`,
    '- Mostre os números-chave: renda, despesas, saldo atual, valor do gasto e forma, saldo final, % da renda comprometida e risco.',
    '- Raciocine sobre ESTE cenário: relacione a parcela/gasto com categorias reais do perfil (cite o NOME e o VALOR exatos de pelo menos uma delas, por exemplo onde ele gasta mais) e explique o que isso significa para o objetivo. Se mencionar o peso de várias categorias juntas, faça isso sem citar um total numérico.',
    '- Termine com uma dica prática e personalizada, ligada a uma categoria real (ex.: ajustar parte de um gasto variável) ou a um dos outros caminhos. Só recomende outro caminho se o veredito dele for CABE (ou diga que cabe com pouca folga). Limite de cartão não é dinheiro disponível.',
    p.principal.cabe
      ? '- Como cabe, diga com honestidade o nível de folga e o que o usuário precisa proteger no mês.'
      : '- Como NÃO cabe, acolha a vontade de comprar sem julgar e não sugira seguir com a compra do jeito atual.',
    '- Finalize com UMA pergunta curta que ajude o usuário a decidir o próximo passo.',
    '',
    'REGRAS:',
    ...REGRAS_GERAIS,
    '',
    'CONVERSA RECENTE:',
    historico,
    '',
    'Escreva agora a recomendação final do Nexo.',
  ].join('\n');
}

function promptExtrato(
  todayISO: string,
  snapshot: Record<string, unknown>,
  messages: ChatMessage[]
): string {
  const historico = messages
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Nexo' : 'Usuário'}: ${m.content}`)
    .join('\n');

  return [
    'Você é o Nexo, um consultor de educação financeira amigável, cordial, empático e acolhedor para jovens adultos.',
    'Você tem acesso aos dados financeiros reais registrados pelo usuário no aplicativo FinançaExec.',
    `Data de hoje: ${todayISO}.`,
    '',
    'REGRAS DE OURO:',
    '- Leia atentamente os DADOS REGISTRADOS abaixo (resumo do mês, saldo total, despesas por categoria, metas e lançamentos recentes) e use-os para embasar suas respostas e dicas práticas.',
    '- Sempre que citar valores ou percentuais, COPIE EXATAMENTE os valores já formatados nos DADOS (com R$ e %). Nunca faça contas de cabeça nem invente números.',
    '- Se o usuário enviar uma saudação, dúvida geral, desabafo ou qualquer mensagem fora de um roteiro rígido, interprete a intenção dele com cordialidade e dê uma resposta útil e coerente usando o contexto dos dados dele quando fizer sentido.',
    '- Ao dar dicas para economizar ou melhorar o saldo, aponte categorias reais onde há maior concentração de gastos nos DADOS e respeite as metas cadastradas.',
    '- Responda de forma clara, humana e organizada (no máximo 6 a 8 frases curtas ou tópicos objetivos).',
    '- Nunca mostre raciocínio interno, rascunho ou termos técnicos (como JSON, snapshot, prompt ou determinístico).',
    '',
    'DADOS REGISTRADOS DO USUÁRIO:',
    JSON.stringify(snapshot, null, 2),
    '',
    'CONVERSA RECENTE:',
    historico,
    '',
    'Responda agora à última mensagem do usuário como o Nexo.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* FALLBACKS (só entram quando o modelo falha nas validações)          */
/* ------------------------------------------------------------------ */

function textoFechamento(b: BaseFinanceira): string {
  const linhas = [
    'Obrigado por compartilhar tudo comigo! Veja como ficou o resumo do seu mês:',
    '',
    `- Renda mensal líquida: **${formatCurrency(b.renda)}**`,
    `- Contas fixas: **${formatCurrency(b.totalFixos)}**`,
    `- Gastos variáveis: **${formatCurrency(b.totalVariaveis)}**`,
    `- Total de despesas: **${formatCurrency(b.totalDespesas)}**`,
    `- Saldo livre atual: **${formatCurrency(b.saldoLivre)}**`,
    `- Comprometimento da renda: **${b.percentualFormatado}** (Risco: **${b.risco}**)`,
    '',
    b.saldoLivre >= 0
      ? 'Quer avaliar algum gasto específico (dizendo o valor e se seria à vista ou parcelado) ou prefere conversar sobre como organizar melhor essa sobra?'
      : 'Como o mês fecha no vermelho por enquanto, quer que eu te ajude a encontrar onde ajustar para voltar para o azul?',
  ];
  return linhas.join('\n');
}

function respostaDeterministicaAnalise(c: Cenario): string {
  const { v } = c;
  const veredito = c.cabe
    ? c.nivel === 'Alerta'
      ? 'CABE, mas com pouca folga no orçamento atual.'
      : 'CABE no orçamento atual.'
    : 'NÃO CABE no orçamento atual.';
  const porque = c.cabe
    ? `Depois do gasto, ainda sobrariam **${v.saldo_depois}** no mês, deixando **${v.pct_depois}** da sua renda comprometida (risco **${c.nivel}**).`
    : `Entendo a vontade de fazer essa compra, mas depois do gasto o saldo ficaria em **${v.saldo_depois}**, faltando **${v.falta}** para fechar o mês no azul (risco **${c.nivel}**).`;
  const dica = c.cabe
    ? `Mantenha o controle dos pequenos gastos e, se puder, separe **${v.semanal}** por semana da folga que sobra.`
    : `Que tal adiar essa compra por um tempinho e separar **${v.semanal}** por semana até juntar o valor que falta?`;

  return [
    `1. **Veredito:** ${veredito}`,
    `2. **Contas:** Renda **${v.renda}**, Despesas **${v.despesas}**, Saldo atual **${v.saldo_antes}**, Valor do gasto **${v.gasto}** (${v.forma}), Saldo final **${v.saldo_depois}** e **${v.pct_depois}** comprometida (Risco: **${c.nivel}**).`,
    `3. **Por quê:** ${porque}`,
    `4. **Dica prática:** ${dica}`,
  ].join('\n');
}

function resumoExtratoDeterministico(snapshot: Record<string, unknown>): string {
  const r = (snapshot.resumo_mes_atual ?? {}) as Record<string, unknown>;
  const d = (snapshot.despesas_mes_atual ?? {}) as Record<string, unknown>;
  const top = Array.isArray(d.detalhamento_por_categoria)
    ? (d.detalhamento_por_categoria as Array<Record<string, unknown>>).slice(0, 3)
    : [];
  const linhas = [
    'Oi! Olhei os dados que você registrou neste mês e aqui está o seu panorama atual:',
    '',
    `- Receitas do mês: **${r.receitas_formatado ?? '—'}**`,
    `- Despesas do mês: **${r.despesas_formatado ?? '—'}**`,
    `- Saldo do mês: **${r.saldo_mes_formatado ?? '—'}** (**${r.percentual_renda_comprometido ?? '0,0%'}** da renda comprometida, Risco: **${r.risco_comprometimento ?? 'Normal'}**)`,
  ];
  if (top.length > 0) {
    linhas.push('', 'Principais categorias de gasto no mês:');
    for (const c of top) {
      linhas.push(`- ${c.categoria}: **${c.total_formatado}** (${c.percentual})`);
    }
  }
  linhas.push('', 'Como posso te ajudar com essas contas hoje?');
  return linhas.join('\n');
}

/* ------------------------------------------------------------------ */
/* VALIDAÇÃO DA SAÍDA DO MODELO                                        */
/* ------------------------------------------------------------------ */

function extrairNumeros(texto: string): string[] {
  const t = texto.replace(/\s/g, ' ').replace(/(\d)\.(\d{1,2})( ?%)/g, '$1,$2$3');
  const re = /(R\$ ?-?|-R\$ ?)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?( ?%)?/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const temMoeda = Boolean(m[1]);
    const temDecimal = m[3] !== undefined;
    const temPct = Boolean(m[4]);
    if (!temMoeda && !temDecimal && !temPct) continue;
    out.push(`${m[2].replace(/\./g, '')}${temDecimal ? ',' + m[3] : ''}${temPct ? '%' : ''}`);
  }
  return out;
}

function permitidosDe(texto: string, extraTexto = ''): Set<string> {
  const set = new Set(extrairNumeros(texto));
  if (extraTexto) {
    for (const n of permitidosDoUsuario(extraTexto)) set.add(n);
  }
  ['0%', '0,0%', '80%', '80,0%', '100%', '100,0%'].forEach((x) => set.add(x));
  return set;
}

function permitidosDoUsuario(texto: string): Set<string> {
  const set = new Set<string>(['0%', '80%', '100%']);
  const re = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const [inteiro, dec] = m[0].split(',');
    const semPonto = inteiro.replace(/\./g, '');
    set.add(`${semPonto},${(dec ?? '00').padEnd(2, '0')}`);
    if (dec !== undefined) set.add(`${semPonto},${dec}`);
  }
  return set;
}

const TERMO_TECNICO = /\bjson\b|<think>|\bprompt\b|\bpython\b/i;

function problemasColeta(texto: string): string[] {
  const p: string[] = [];
  if (!texto.includes('?')) p.push('sem pergunta');
  if (texto.length > 650) p.push('resposta longa demais');
  if (TERMO_TECNICO.test(texto)) p.push('termo técnico');
  return p;
}

function problemasConversa(texto: string, apresentar: boolean): string[] {
  const p = problemasColeta(texto);
  if (apresentar && !/\bNexo\b/i.test(texto)) p.push('não se apresentou pelo nome');
  return p;
}

function problemasFechamento(texto: string, b: BaseFinanceira): string[] {
  const p: string[] = [];
  if (!MARCADOR_FECHAMENTO.test(texto)) p.push('faltou a expressão "Resumo do seu mês:"');
  const citados = new Set(extrairNumeros(texto));
  for (const alvo of [extrairNumeros(formatCurrency(b.saldoLivre))[0], extrairNumeros(b.percentualFormatado)[0]]) {
    if (alvo && !citados.has(alvo)) p.push(`não citou ${alvo}`);
  }
  if (!texto.includes('?')) p.push('sem pergunta final');
  if (TERMO_TECNICO.test(texto)) p.push('termo técnico');
  return p;
}

function citaCategoriaReal(texto: string, perfil: Perfil): boolean {
  const top = [...perfil.variaveis, ...perfil.fixos]
    .filter((i) => (i.valor ?? 0) > 0)
    .sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0))
    .slice(0, 4);
  if (top.length === 0) return true;
  return top.some((i) => mencionaTermo(texto, i.descricao));
}

function problemasRecomendacao(texto: string, c: Cenario, perfil: Perfil): string[] {
  const p: string[] = [];
  if (!MARCADOR_VEREDITO.test(texto)) p.push('faltou o veredito');
  const linhaVeredito = texto.split('\n').find((l) => MARCADOR_VEREDITO.test(l)) ?? '';
  const dizNaoCabe = /n[aã]o\s+cabe|n[aã]o\s+(?:[eé]\s+)?recomend/i.test(linhaVeredito);
  if (c.cabe && dizNaoCabe) p.push('veredito invertido (o gasto cabe)');
  if (!c.cabe && !dizNaoCabe) p.push('veredito invertido (o gasto não cabe)');
  if (c.cabe && c.nivel === 'Alerta' && !/folga|limite|apertad/i.test(linhaVeredito)) {
    p.push('veredito não menciona que a folga é pequena');
  }
  const citados = new Set(extrairNumeros(texto));
  for (const chave of ['saldo_depois', 'pct_depois']) {
    const alvo = extrairNumeros(c.v[chave])[0];
    if (alvo && !citados.has(alvo)) {
      p.push(`não citou ${chave === 'saldo_depois' ? 'o saldo final' : 'o percentual comprometido'}`);
    }
  }
  if (!citaCategoriaReal(texto, perfil)) p.push('dica genérica: não citou nenhuma categoria real do perfil');
  if (!texto.includes('?')) p.push('sem pergunta final');
  if (TERMO_TECNICO.test(texto)) p.push('termo técnico');
  return p;
}

/* ------------------------------------------------------------------ */
/* CHAMADA AO LLM (Groq / Ollama) — inalterado                         */
/* ------------------------------------------------------------------ */

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^(?:thinking process|racioc[ií]nio|fluxo de pensamento):[\s\S]*?(?=\n\n|$)/i, '')
    .trim();
}

let provedorAtivo: 'groq' | 'ollama' = GROQ_API_KEY ? 'groq' : 'ollama';

async function callOllama(
  prompt: string,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<{ raw: string; texto: string }> {
  const usandoGroq = provedorAtivo === 'groq' && Boolean(GROQ_API_KEY);
  const ehGptOss = usandoGroq && /gpt-oss/i.test(GROQ_MODEL);
  const limiteTokens = opts.maxTokens ?? (OLLAMA_THINK || ehGptOss ? 2048 : 850);

  if (usandoGroq) {

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature ?? OLLAMA_TEMPERATURE,
        max_tokens: limiteTokens,
        // modelos de raciocínio gastam max_tokens "pensando"; sem isso o JSON pode vir vazio/cortado
        ...(ehGptOss ? { reasoning_effort: 'low' } : {}),
      }),
      signal: opts.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Erro na Groq (${response.status}): ${errBody}`);
    }

    const data = await response.json();
    const raw = String(data?.choices?.[0]?.message?.content || '');
    const texto = stripThinkBlocks(raw);
    return { raw, texto };
  }

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: OLLAMA_THINK,
      options: {
        temperature: opts.temperature ?? OLLAMA_TEMPERATURE,
        num_ctx: OLLAMA_NUM_CTX,
        num_predict: limiteTokens,
      },
    }),
    signal: opts.signal,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Erro no Ollama (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  const raw = String(data?.message?.content || '');
  const texto = stripThinkBlocks(raw);
  return { raw, texto };
}

// Loop de validação (P05 "revisar validação"): reescreve até MAX_TENTATIVAS e só então usa o fallback
async function gerarComValidacao(params: {
  fase: string;
  prompt: string;
  permitidos: Set<string>;
  extra?: (texto: string) => string[];
  fallback: () => string;
  signal?: AbortSignal;
}): Promise<string> {
  let prompt = params.prompt;

  for (let i = 0; i < MAX_TENTATIVAS; i++) {
    const temperature = Math.min(OLLAMA_TEMPERATURE + i * 0.2, 0.9);
    const { raw, texto } = await callOllama(prompt, { temperature, signal: params.signal });

    const problemas: string[] = [];
    if (!texto) problemas.push('resposta vazia');
    const invalidos = extrairNumeros(texto).filter((n) => !params.permitidos.has(n));
    if (invalidos.length > 0) problemas.push(`valores fora da lista: ${invalidos.join(', ')}`);
    if (params.extra) problemas.push(...params.extra(texto));

    logEvento({
      tipo: 'tentativa',
      fase: params.fase,
      tentativa: i + 1,
      temperature,
      ok: problemas.length === 0,
      problemas,
      prompt,
      resposta_bruta: raw,
    });

    if (problemas.length === 0) return texto;

    prompt =
      params.prompt +
      `\n\nCORREÇÃO: sua resposta anterior foi recusada (${problemas.join('; ')}). Escreva de novo seguindo exatamente as regras e usando somente os valores permitidos.`;
  }

  logEvento({ tipo: 'fallback', fase: params.fase });
  return params.fallback();
}

/* ------------------------------------------------------------------ */
/* ORQUESTRAÇÃO                                                        */
/* ------------------------------------------------------------------ */

async function responderPendencia(
  pend: Pendencia,
  perfil: Perfil,
  messages: ChatMessage[],
  apresentar: boolean,
  ultimaMsg: string,
  signal?: AbortSignal
): Promise<string> {
  return gerarComValidacao({
    fase: 'ESCLARECIMENTO',
    prompt: promptConversa({
      apresentar,
      historico: messages,
      tarefa: tarefaPendencia(pend),
      contexto: linhasItens(perfil),
    }),
    permitidos: permitidosPerfil(perfil, `${ultimaMsg} ${pend.detalhe}`),
    extra: (t) => [
      ...problemasConversa(t, apresentar),
      ...(mencionaTermo(t, pend.item) ? [] : ['não citou o item em dúvida']),
    ],
    fallback: () => `Só para eu não errar a conta: sobre "${pend.item}", pode me confirmar o valor certo?`,
    signal,
  });
}

async function responderConversa(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const d = await decidirFluxo(messages, signal);
  logEvento({
    tipo: 'fluxo',
    fase: d.fase,
    intencao: d.intencao,
    ultima_mensagem: d.ultimaMsg,
    perfil: d.perfil,
    pendencia: d.pendencia,
    gasto: d.gasto,
  });

  // Falha técnica na leitura: não culpa o usuário nem entra em loop pedindo os números de novo
  if (d.extracaoFalhou) {
    return 'Tive um probleminha técnico para ler sua mensagem agora (nada que você tenha escrito errado). Pode enviar de novo em instantes? Seus dados anteriores continuam na conversa.';
  }

  switch (d.fase) {
    case 'APRESENTACAO':
    case 'COLETA': {
      const alvo: AlvoColeta = d.alvoColeta ?? 'renda';
      const tarefa =
        d.fase === 'APRESENTACAO'
          ? [
              'Cumprimente de volta de forma natural, reagindo ao que o usuário escreveu.',
              'Explique em uma frase que você ajuda a organizar o orçamento do mês e a avaliar compras.',
              `Faça UMA pergunta convidativa para saber ${ALVOS_COLETA.renda}.`,
            ]
          : [
              'Responda de forma natural e gentil ao que o usuário acabou de dizer (mesmo que seja dúvida ou comentário fora do esperado).',
              'Se ele já informou algum valor, reconheça brevemente o que entendeu, usando só os valores do CONTEXTO.',
              `Em seguida, faça UMA pergunta convidativa para saber ${ALVOS_COLETA[alvo]}.`,
            ];
      return gerarComValidacao({
        fase: d.fase,
        prompt: promptConversa({ apresentar: d.apresentar, historico: messages, tarefa, contexto: linhasItens(d.perfil) }),
        permitidos: permitidosPerfil(d.perfil, d.ultimaMsg),
        extra: (t) => problemasConversa(t, d.apresentar),
        fallback: () => FALLBACK_COLETA[alvo],
        signal,
      });
    }

    case 'ESCLARECIMENTO':
      return responderPendencia(d.pendencia as Pendencia, d.perfil, messages, d.apresentar, d.ultimaMsg, signal);

    case 'CONFIRMACAO':
      return gerarComValidacao({
        fase: 'CONFIRMACAO',
        prompt: promptConversa({
          apresentar: d.apresentar,
          historico: messages,
          tarefa: [
            'Resuma em linguagem natural o que você entendeu até aqui (renda, contas fixas e gastos do dia a dia), citando os itens com os valores do CONTEXTO.',
            'Depois pergunte, usando a expressão "mais alguma despesa", se há mais alguma despesa ou detalhe que ele queira incluir antes de você consolidar o mês (ex.: cartão, academia, transporte, dívidas).',
            'Não mencione compras que ele queira fazer nesta mensagem.',
          ],
          contexto: linhasItens(d.perfil),
        }),
        permitidos: permitidosPerfil(d.perfil, d.ultimaMsg),
        extra: (t) => [
          ...problemasConversa(t, d.apresentar).filter((x) => x !== 'resposta longa demais'),
          ...(REGEX_CONFIRMACAO.test(t) ? [] : ['faltou perguntar se há "mais alguma despesa"']),
        ],
        fallback: () => 'Anotei tudo isso. Antes de consolidar o seu mês, você tem mais alguma despesa ou detalhe para incluir?',
        signal,
      });

    case 'FECHAMENTO': {
      const { base } = obterBase(d.perfil);
      const contexto = [...linhasBase(base), ...linhasItens(d.perfil)];
      return gerarComValidacao({
        fase: 'FECHAMENTO',
        prompt: promptConversa({
          apresentar: d.apresentar,
          historico: messages,
          tarefa: [
            'Se a última mensagem do usuário trouxe uma dúvida, responda-a em uma frase primeiro.',
            'Escreva "Resumo do seu mês:" e, em lista, renda, contas fixas, gastos variáveis, total de despesas, saldo livre e comprometimento da renda (com o risco).',
            'Faça uma leitura breve e gentil da situação citando o nome e o valor das categorias onde ele mais gasta.',
            base.saldoLivre >= 0
              ? 'Encerre com UMA pergunta aberta: ele quer avaliar um gasto específico (valor e à vista/parcelado) ou conversar sobre como organizar a sobra?'
              : 'Como o mês fecha no vermelho, encerre com UMA pergunta oferecendo ajuda para reorganizar as contas antes de assumir novos gastos.',
            ...(d.perfil.ignorados.length > 0
              ? [`Avise que ${d.perfil.ignorados.join(', ')} ficou fora do cálculo por falta de valor, e que ele pode informar depois.`]
              : []),
          ],
          contexto,
        }),
        permitidos: permitidosDe(contexto.join(' '), d.ultimaMsg),
        extra: (t) => problemasFechamento(t, base),
        fallback: () => textoFechamento(base),
        signal,
      });
    }

    case 'CONSULTORIA': {
      let base: BaseFinanceira;
      let cenarioLinhas: string[] = [];
      let principal: Cenario | undefined;
      if (d.gasto) {
        const caminhos = gerarCaminhos(d.perfil, d.gasto);
        base = caminhos.base;
        principal = caminhos.principal;
        cenarioLinhas = [
          `Compra em avaliação: ${d.gasto.descricao ?? 'compra'}`,
          ...caminhos.principal.linhasDados.split('\n'),
          ...caminhos.alternativas.map(resumoCaminho),
        ];
      } else {
        base = obterBase(d.perfil).base;
      }
      const contexto = [...linhasBase(base), ...linhasItens(d.perfil), ...cenarioLinhas];
      return gerarComValidacao({
        fase: 'CONSULTORIA',
        prompt: promptConversa({
          apresentar: d.apresentar,
          historico: messages,
          tarefa: [
            'Responda exatamente o que o usuário perguntou ou comentou na última mensagem.',
            'Dê no máximo 3 dicas. Cada dica deve se ligar a uma categoria REAL do perfil (cite o nome e o valor exatos) e ao objetivo dele (por exemplo, a compra em avaliação, se houver).',
            'Raciocine sobre o cenário dele: compare categorias reais com o objetivo de forma qualitativa (ex.: "sua parcela é menor do que o que você gasta com delivery") e explique por que a dica faz sentido.',
            'Não repita dicas já dadas na conversa e evite conselhos genéricos que serviriam para qualquer pessoa.',
          ],
          contexto,
        }),
        permitidos: permitidosDe(contexto.join(' '), d.ultimaMsg),
        extra: (t) => [
          ...(TERMO_TECNICO.test(t) ? ['termo técnico'] : []),
          ...(citaCategoriaReal(t, d.perfil) ? [] : ['dica genérica: não citou nenhuma categoria real do perfil']),
        ],
        fallback: () =>
          principal
            ? respostaDeterministicaAnalise(principal)
            : `Com base no seu resumo atual (renda de **${formatCurrency(base.renda)}**, despesas de **${formatCurrency(base.totalDespesas)}**, saldo livre de **${formatCurrency(base.saldoLivre)}** e **${base.percentualFormatado}** da renda comprometida — risco **${base.risco}**), o melhor caminho agora é olhar seus maiores gastos variáveis. Quer escolher um deles para revisarmos juntos?`,
        signal,
      });
    }

    case 'RECOMENDACAO': {
      const gasto = d.gasto as Gasto;
      const { base, principal, alternativas } = gerarCaminhos(d.perfil, gasto);
      logEvento({ tipo: 'cenario', valores: principal.v, cabe: principal.cabe, nivel: principal.nivel });
      const dadosPermitidos = [
        principal.linhasDados,
        ...alternativas.map(resumoCaminho),
        ...linhasBase(base),
        ...linhasItens(d.perfil),
      ].join('\n');
      return gerarComValidacao({
        fase: 'RECOMENDACAO',
        prompt: promptRecomendacao({ apresentar: d.apresentar, principal, alternativas, perfil: d.perfil, base, historico: messages }),
        permitidos: permitidosDe(dadosPermitidos, d.ultimaMsg),
        extra: (t) => problemasRecomendacao(t, principal, d.perfil),
        fallback: () => respostaDeterministicaAnalise(principal),
        signal,
      });
    }
  }
}

// Modo "extrato": o usuário já tem lançamentos no painel
function extrairValorGastoEParcelas(text: string): {
  valorGasto?: number;
  parcelas?: number;
} {
  let parcelas: number | undefined;

  const parcMatch = text.match(/\b(\d{1,2})\s*(?:x|vezes|parcelas?)\b/i);
  if (parcMatch) {
    const nParc = parseInt(parcMatch[1], 10);
    if (!Number.isNaN(nParc) && nParc >= 2 && nParc <= 60) {
      parcelas = nParc;
    }
  }

  const semParcelas = text.replace(/\b\d{1,2}\s*(?:x|vezes|parcelas?)\b/gi, ' ');
  const matches = Array.from(
    semParcelas.matchAll(/(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/g)
  );

  let valorGasto: number | undefined;
  for (const m of matches) {
    const raw = m[1].includes(',')
      ? m[1].replace(/\./g, '').replace(',', '.')
      : m[1];
    const num = parseFloat(raw);
    if (!Number.isNaN(num) && num > 0) {
      if (!parcelas || num !== parcelas || /R\$|reais|valor|gasto|compra|pagar|cust[ao]/i.test(semParcelas)) {
        valorGasto = num;
      }
    }
  }

  return { valorGasto, parcelas };
}

async function responderExtrato(
  messages: ChatMessage[],
  financialData: FinancialDataPayload,
  todayISO: string,
  signal?: AbortSignal
): Promise<string> {
  const snapshot = buildDeterministicSnapshot(financialData, todayISO);
  const ultimaMsg = messages.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '';
  const apresentar = !messages.some((m) => m.role === 'assistant' && /\bNexo\b/i.test(m.content));
  logEvento({ tipo: 'fluxo', fase: 'EXTRATO', lancamentos: financialData.transactions?.length ?? 0 });

  const { valorGasto, parcelas } = extrairValorGastoEParcelas(ultimaMsg);
  const despSnap = snapshot.despesas_mes_atual as Record<string, unknown>;
  const recMes = Number((snapshot.receitas_mes_atual as Record<string, unknown>).total_geral) || 0;

  if (valorGasto !== undefined && REGEX_INTENCAO_COMPRA.test(ultimaMsg) && recMes > 0) {
    const cats = Array.isArray(despSnap.detalhamento_por_categoria)
      ? (despSnap.detalhamento_por_categoria as Array<Record<string, unknown>>)
      : [];
    // Cada categoria real do painel vira um item do perfil para o raciocínio da recomendação
    const perfil: Perfil = {
      renda: recMes,
      fixos: [],
      variaveis: cats.map((c) => ({ descricao: String(c.categoria), valor: Number(c.total) || 0, tipo: 'variavel' as const })),
      ignorados: [],
    };
    const gasto: Gasto = { valor: valorGasto, parcelas: parcelas ?? 1, descricao: 'compra' };
    const { base, principal, alternativas } = gerarCaminhos(perfil, gasto);
    logEvento({ tipo: 'cenario_extrato', valores: principal.v, cabe: principal.cabe, nivel: principal.nivel });

    const dadosPermitidos = [
      principal.linhasDados,
      ...alternativas.map(resumoCaminho),
      ...linhasBase(base),
      ...linhasItens(perfil),
    ].join('\n');
    return gerarComValidacao({
      fase: 'RECOMENDACAO_EXTRATO',
      prompt: promptRecomendacao({ apresentar, principal, alternativas, perfil, base, historico: messages }),
      permitidos: permitidosDe(dadosPermitidos, ultimaMsg),
      extra: (t) => problemasRecomendacao(t, principal, perfil),
      fallback: () => respostaDeterministicaAnalise(principal),
      signal,
    });
  }

  return gerarComValidacao({
    fase: 'EXTRATO',
    prompt: promptExtrato(todayISO, snapshot, messages),
    permitidos: permitidosDe(JSON.stringify(snapshot), ultimaMsg),
    extra: (t) => (TERMO_TECNICO.test(t) ? ['termo técnico'] : []),
    fallback: () => resumoExtratoDeterministico(snapshot),
    signal,
  });
}

async function responder(
  messages: ChatMessage[],
  financialData: FinancialDataPayload | undefined,
  todayISO: string,
  signal?: AbortSignal
): Promise<string> {
  const txCount = Array.isArray(financialData?.transactions) ? financialData.transactions.length : 0;
  if (financialData && typeof financialData === 'object' && txCount > 0) {
    return responderExtrato(messages, financialData, todayISO, signal);
  }
  return responderConversa(messages, signal);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/provider', (_req, res) => {
  res.json({ provider: provedorAtivo });
});

app.post('/api/provider', (req, res) => {
  const { provider } = (req.body || {}) as { provider?: string };
  if (provider === 'ollama' || provider === 'groq') {
    provedorAtivo = provider;
    res.json({ ok: true, provider: provedorAtivo });
    return;
  }
  res.status(400).json({ error: 'Provedor inválido. Use "ollama" ou "groq".' });
});

  app.post('/api/chat', async (req, res) => {
    const { messages, stream, financial_data } = (req.body || {}) as {
      messages?: ChatMessage[];
      stream?: boolean;
      financial_data?: FinancialDataPayload;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Envie ao menos uma mensagem para o assistente.' });
      return;
    }

    const todayISO =
      financial_data &&
      typeof financial_data.today === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(financial_data.today)
        ? financial_data.today
        : getServerTodayISO();

    const historico: ChatMessage[] = messages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.content.slice(0, 4000),
      }));

    if (historico.length === 0) {
      res.status(400).json({ error: 'Conteúdo da mensagem inválido.' });
      return;
    }

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      try {
        const replyText = await responder(historico, financial_data, todayISO, abortController.signal);
        if (replyText && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ text: replyText })}\n\n`);
        }
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erro ao consultar o Ollama.';
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
          res.end();
        }
      }
      return;
    }

    try {
      const replyText = await responder(historico, financial_data, todayISO, abortController.signal);
      res.json({ reply: replyText });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao consultar o Ollama.';
      res.status(500).json({ error: message });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

app.listen(PORT, '0.0.0.0', () => {
    const modo = GROQ_API_KEY
      ? `Groq (model: ${GROQ_MODEL})`
      : `Ollama (${OLLAMA_URL}, model: ${OLLAMA_MODEL})`;
    console.log(`FinançaExec server listening on http://0.0.0.0:${PORT} | IA: ${modo}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});