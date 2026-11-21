import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

/* ------------------------------------------------------------------ */
/* EXTRAÇÃO DOS VALORES DITOS PELO USUÁRIO NA CONVERSA                 */
/* ------------------------------------------------------------------ */

const REGEX_MENSAGEM_RENDA =
  /\b(renda|sal[aá]rio|ganho|ganha|ganhar|recebo|receber|entrada|holerite|contracheque|l[ií]quido)\b/i;

const REGEX_INTENCAO_COMPRA =
  /\b(comprar|compra|gastar|gasto|avaliar|posso pagar|vale a pena|parcelar|parcelado|[àa]\s*vista|t[eê]nis|celular|notebook|placa de v[ií]deo|fone|roupa|viagem|presente|tv|videogame)\b/i;

function parseValoresSeparados(text: string): {
  fixos: number[];
  variaveis: number[];
  teveFaixa: boolean;
} {
  const fixos: number[] = [];
  const variaveis: number[] = [];
  let teveFaixa = false;

  const rangeRegex =
    /(?:entre\s+)?(?:R\$\s*)?(\d+(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)\s*(?:e|a|-)\s*(?:R\$\s*)?(\d+(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/gi;

  const semFaixas = text.replace(rangeRegex, (_full, v1, v2) => {
    const n1 = parseFloat(String(v1).replace(/\./g, '').replace(',', '.'));
    const n2 = parseFloat(String(v2).replace(/\./g, '').replace(',', '.'));
    if (!Number.isNaN(n1) && !Number.isNaN(n2)) {
      teveFaixa = true;
      variaveis.push(Math.max(n1, n2));
    }
    return ' ';
  });

  const singleRegex = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/g;
  let match: RegExpExecArray | null;
  while ((match = singleRegex.exec(semFaixas)) !== null) {
    const raw = match[1].includes(',')
      ? match[1].replace(/\./g, '').replace(',', '.')
      : match[1];
    const num = parseFloat(raw);
    if (!Number.isNaN(num) && num > 0) {
      const antes = semFaixas.slice(Math.max(0, match.index - 22), match.index);
      const depois = semFaixas.slice(match.index + match[0].length, match.index + match[0].length + 22);
      const trechoLocal = `${antes} ${depois}`;

      const ehFixoExplicito =
        /fixo|fixos|aluguel|internet|energia|luz|[aá]gua|spotify|hbo(\s*max)?|netflix|disney|google\s*one|prime|youtube|assinatura|streaming|condom[ií]nio|celular|plano/i.test(
          trechoLocal
        );
      const ehVarExplicito =
        /vari[aá]vel|vari[aá]veis|alimenta[cç][aã]o|mercado|supermercado|delivery|ifood|lanche|feira|lazer|transporte|dia\s*a\s*dia/i.test(
          trechoLocal
        );

      if (ehFixoExplicito && !ehVarExplicito) {
        fixos.push(num);
      } else if (ehVarExplicito) {
        variaveis.push(num);
      } else {
        fixos.push(num);
      }
    }
  }

  return { fixos, variaveis, teveFaixa };
}

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

/* ------------------------------------------------------------------ */
/* PERFIL, FASE E CÁLCULO DETERMINÍSTICO                               */
/* ------------------------------------------------------------------ */

interface Perfil {
  renda?: number;
  fixos: number[];
  variaveis: number[];
  faixaAtiva: boolean;
}

type Fase = 'RENDA' | 'FIXOS' | 'VARIAVEIS' | 'FECHAMENTO' | 'CONSULTORIA' | 'ANALISE';

interface Gasto {
  valor: number;
  parcelas: number;
}

interface Decisao {
  fase: Fase;
  perfil: Perfil;
  ultimaMsg: string;
  gasto?: Gasto;
}

const MARCADOR_FECHAMENTO = /resumo do seu m[eê]s:/i;
const PERGUNTA_FECHAMENTO_POSITIVO =
  'Agora me conta, com calma: você quer avaliar algum gasto específico (dizendo o valor e se seria à vista ou parcelado) ou prefere conversar sobre como organizar melhor essa sobra?';
const PERGUNTA_FECHAMENTO_NEGATIVO =
  'Como o mês fecha no vermelho por enquanto, o mais importante agora é reorganizar as contas antes de assumir novos gastos. Quer que eu te ajude a encontrar onde cortar ou ajustar para voltar para o azul?';

const somaMoney = (arr: number[]): number => roundMoney(arr.reduce((s, n) => s + n, 0));

const perfilCompleto = (p: Perfil): boolean =>
  p.renda !== undefined && p.renda > 0 && p.fixos.length > 0 && p.variaveis.length > 0;

function montarPerfil(userMsgs: string[]): Perfil {
  const turnos = userMsgs
    .map((txt, idx) => ({ idx, txt, ...parseValoresSeparados(txt) }))
    .filter((t) => t.fixos.length > 0 || t.variaveis.length > 0);

  if (turnos.length === 0) return { fixos: [], variaveis: [], faixaAtiva: false };

  let renda: number | undefined;
  const indicesRenda = new Set<number>();

  // 1. Identifica todos os turnos que mencionam renda explicitamente (atualiza/deduplica sem somar em despesas)
  for (const t of turnos) {
    if (REGEX_MENSAGEM_RENDA.test(t.txt)) {
      const val = t.fixos[0] ?? t.variaveis[0];
      if (typeof val === 'number' && val > 0) {
        renda = val;
        indicesRenda.add(t.idx);
      }
    }
  }

  // 2. Fallback: se nenhum turno mencionou a palavra "renda/recebo/salário", usa o primeiro turno com valor
  if (renda === undefined) {
    const primeiro = turnos[0];
    renda = primeiro.fixos[0] ?? primeiro.variaveis[0];
    indicesRenda.add(primeiro.idx);
  } else {
    // Se o primeiro turno era apenas o número puro da renda (ex.: "2600") e o usuário depois confirmou "Eu recebo 2600,00"
    const primeiro = turnos[0];
    const unicoPrimeiro =
      primeiro.fixos.length + primeiro.variaveis.length === 1
        ? (primeiro.fixos[0] ?? primeiro.variaveis[0])
        : undefined;
    if (unicoPrimeiro !== undefined && Math.abs(unicoPrimeiro - renda) < 0.01) {
      indicesRenda.add(primeiro.idx);
    }
  }

  const turnosDespesa = turnos.filter((t) => !indicesRenda.has(t.idx));
  const fixos: number[] = [];
  const variaveis: number[] = [];
  let faixaAtiva = false;

  for (let i = 0; i < turnosDespesa.length; i++) {
    const t = turnosDespesa[i];
    const prev = i > 0 ? turnosDespesa[i - 1] : undefined;

    const ehConfirmacaoUnica =
      t.fixos.length + t.variaveis.length === 1 &&
      !/\+|e\s+\d|aluguel|internet|energia|água|agua|spotify|netflix|hbo|disney|google/i.test(t.txt);
    const valorUnico = t.variaveis[0] ?? t.fixos[0];

    if (prev?.teveFaixa && ehConfirmacaoUnica && typeof valorUnico === 'number') {
      const ultimoVarIdx = variaveis.length - 1;
      if (ultimoVarIdx >= 0) variaveis[ultimoVarIdx] = valorUnico;
      else variaveis.push(valorUnico);
      faixaAtiva = false;
      continue;
    }

    fixos.push(...t.fixos);
    variaveis.push(...t.variaveis);
    if (t.teveFaixa) faixaAtiva = true;
  }

  if (turnosDespesa.length >= 2 && variaveis.length === 0) {
    const ultimo = turnosDespesa[turnosDespesa.length - 1];
    const qtd = ultimo.fixos.length;
    if (qtd > 0 && fixos.length > qtd) {
      const movidos = fixos.splice(fixos.length - qtd, qtd);
      variaveis.push(...movidos);
    }
  }

  const ultimaMsg = userMsgs[userMsgs.length - 1] ?? '';
  if (
    renda !== undefined &&
    fixos.length > 0 &&
    variaveis.length === 0 &&
    !/\d/.test(ultimaMsg) &&
    /\b(nada|nenhum|nenhuma|zero)\b|n[aã]o\s+(tenho|gasto|possuo|costumo)/i.test(ultimaMsg)
  ) {
    variaveis.push(0);
  }

  return { renda, fixos, variaveis, faixaAtiva };
}

function decidirFluxo(messages: ChatMessage[]): Decisao {
  const userMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const ultimaMsg = userMsgs[userMsgs.length - 1] ?? '';

  const idxFech = messages.findIndex((m) => m.role === 'assistant' && MARCADOR_FECHAMENTO.test(m.content));
  if (idxFech >= 0) {
    const nAntes = messages.slice(0, idxFech).filter((m) => m.role === 'user').length;
    const perfilFechado = montarPerfil(userMsgs.slice(0, nAntes));
    if (perfilCompleto(perfilFechado) && userMsgs.length > nAntes) {
      const { valorGasto, parcelas } = extrairValorGastoEParcelas(ultimaMsg);
      if (valorGasto !== undefined && REGEX_INTENCAO_COMPRA.test(ultimaMsg)) {
        return {
          fase: 'ANALISE',
          perfil: perfilFechado,
          ultimaMsg,
          gasto: { valor: valorGasto, parcelas: parcelas ?? 1 },
        };
      }
      // Qualquer outra pergunta ou resposta fora do fluxo de compra vai para CONSULTORIA livre
      return { fase: 'CONSULTORIA', perfil: perfilFechado, ultimaMsg };
    }
  }

  const perfil = montarPerfil(userMsgs);
  if (perfil.renda === undefined) return { fase: 'RENDA', perfil, ultimaMsg };
  if (perfil.fixos.length === 0) return { fase: 'FIXOS', perfil, ultimaMsg };
  if (perfil.variaveis.length === 0) return { fase: 'VARIAVEIS', perfil, ultimaMsg };
  return { fase: 'FECHAMENTO', perfil, ultimaMsg };
}

interface BaseFinanceira {
  renda: number;
  totalFixos: number;
  totalVariaveis: number;
  totalDespesas: number;
}

const lerNumero = (obj: Record<string, unknown> | null, chave: string): number | undefined => {
  const v = obj ? obj[chave] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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

function obterBase(perfil: Perfil, gasto?: Gasto): BaseFinanceira {
  const renda = perfil.renda ?? 0;
  const totalFixosTs = somaMoney(perfil.fixos);
  const totalVariaveisTs = somaMoney(perfil.variaveis);
  const totalDespesasTs = roundMoney(totalFixosTs + totalVariaveisTs);

  const payload: Record<string, unknown> = { renda, fixos: perfil.fixos, variaveis: perfil.variaveis };
  if (gasto) {
    payload.valor_gasto = gasto.valor;
    if (gasto.parcelas > 1) payload.parcelas = gasto.parcelas;
  }
  const py = executarPython(payload);
  if (py) console.log('[PYTHON CALCULO]', JSON.stringify(py));

  const base: BaseFinanceira = {
    renda: lerNumero(py, 'renda') ?? renda,
    totalFixos: lerNumero(py, 'total_fixos') ?? totalFixosTs,
    totalVariaveis: lerNumero(py, 'total_variaveis') ?? totalVariaveisTs,
    totalDespesas: lerNumero(py, 'total_despesas') ?? totalDespesasTs,
  };

  if (Math.abs(base.totalDespesas - totalDespesasTs) > 0.005 || Math.abs(base.renda - renda) > 0.005) {
    logEvento({
      tipo: 'divergencia_python_ts',
      python: { renda: base.renda, total_despesas: base.totalDespesas },
      ts: { renda, total_despesas: totalDespesasTs },
    });
  }
  return base;
}

interface Cenario {
  cabe: boolean;
  nivel: NivelRisco;
  veredito: string;
  parcelado: boolean;
  v: Record<string, string>;
  linhasDados: string;
}

function calcularCenario(base: BaseFinanceira, gasto: Gasto): Cenario {
  const saldoAntes = roundMoney(base.renda - base.totalDespesas);
  const parcelado = gasto.parcelas > 1;
  const valorNoMes = parcelado ? roundMoney(gasto.valor / gasto.parcelas) : gasto.valor;
  const saldoDepois = roundMoney(saldoAntes - valorNoMes);

  const comprometimento = calcularComprometimentoRenda(base.renda, base.totalDespesas, valorNoMes);
  const nivel = comprometimento.risco;
  const cabe = saldoDepois >= 0;
  const veredito = !cabe ? 'NÃO CABE' : nivel === 'Alerta' ? 'CABE, MAS COM POUCA FOLGA' : 'CABE';
  const falta = cabe ? 0 : roundMoney(-saldoDepois);
  const semanal = roundMoney((cabe ? saldoDepois : falta) / 4);

  const v: Record<string, string> = {
    renda: formatCurrency(base.renda),
    despesas: formatCurrency(base.totalDespesas),
    saldo_antes: formatCurrency(saldoAntes),
    gasto: formatCurrency(gasto.valor),
    forma: parcelado ? `${gasto.parcelas}x de ${formatCurrency(valorNoMes)}` : 'à vista',
    impacto_mes: formatCurrency(valorNoMes),
    saldo_depois: formatCurrency(saldoDepois),
    pct_depois: comprometimento.percentualFormatado,
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

  return { cabe, nivel, veredito, parcelado, v, linhasDados: linhas.join('\n') };
}

/* ------------------------------------------------------------------ */
/* TEXTOS DETERMINÍSTICOS E FALLBACKS CORDIAIS                         */
/* ------------------------------------------------------------------ */

const PERGUNTAS_COLETA: Record<'RENDA' | 'FIXOS' | 'VARIAVEIS', { alvo: string; fallback: string }> = {
  RENDA: {
    alvo: 'a renda mensal líquida (o valor que cai na conta por mês)',
    fallback: 'Oi! Tudo bem? Sou o Nexo, seu parceiro de organização financeira. Para começarmos, qual é a sua renda mensal líquida (o valor que cai na sua conta por mês)?',
  },
  FIXOS: {
    alvo: 'o valor das contas fixas do mês (aluguel, internet, energia, água, assinaturas etc.)',
    fallback: 'Obrigado por compartilhar! Agora me conta: quanto você paga por mês em contas fixas (como aluguel, internet, energia, água e assinaturas)?',
  },
  VARIAVEIS: {
    alvo: 'quanto costuma gastar por mês com o dia a dia (mercado, alimentação, delivery, transporte, lazer)',
    fallback: 'Perfeito! E quanto você costuma gastar por mês com as despesas do dia a dia (mercado, alimentação, delivery, transporte e lazer)?',
  },
};

function textoFechamento(b: BaseFinanceira, faixaAtiva: boolean): string {
  const saldoLivre = roundMoney(b.renda - b.totalDespesas);
  const comprometimento = calcularComprometimentoRenda(b.renda, b.totalDespesas);

  const linhas = [
    'Obrigado por compartilhar tudo comigo! Veja como ficou o resumo do seu mês:',
    '',
    `- Renda mensal líquida: **${formatCurrency(b.renda)}**`,
    `- Contas fixas: **${formatCurrency(b.totalFixos)}**`,
    `- Gastos variáveis: **${formatCurrency(b.totalVariaveis)}**`,
    `- Total de despesas: **${formatCurrency(b.totalDespesas)}**`,
    `- Saldo livre atual: **${formatCurrency(saldoLivre)}**`,
    `- Comprometimento da renda: **${comprometimento.percentualFormatado}** (Risco: **${comprometimento.risco}**)`,
  ];
  if (faixaAtiva) {
    linhas.push(
      '',
      'Como você informou uma faixa de valores nos gastos variáveis, adotei o maior valor dela por segurança no cálculo.'
    );
  }
  linhas.push(
    '',
    saldoLivre >= 0 ? PERGUNTA_FECHAMENTO_POSITIVO : PERGUNTA_FECHAMENTO_NEGATIVO
  );
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

/* ------------------------------------------------------------------ */
/* PROMPTS OTIMIZADOS (CORDIAIS, CONSULTIVOS E RESILIENTES)            */
/* ------------------------------------------------------------------ */

function promptColeta(fase: 'RENDA' | 'FIXOS' | 'VARIAVEIS', ultimaMsg: string): string {
  return [
    'Você é o Nexo, um consultor de educação financeira amigável, cordial, empático e acolhedor para jovens adultos.',
    'Fale como um parceiro de confiança: simpático, humano, sem julgamentos e em português do Brasil.',
    'TAREFA:',
    `- Primeiro, interprete e responda de forma natural e gentil ao que o usuário acabou de dizer (mesmo se for uma saudação, dúvida ou comentário fora do esperado).`,
    `- Em seguida, faça UMA única pergunta convidativa para saber ${PERGUNTAS_COLETA[fase].alvo}.`,
    'REGRAS:',
    '- Seja breve (no máximo 3 frases curtas).',
    '- Não faça cálculos, não invente números e não mostre raciocínio interno.',
    '- Nunca mencione palavras técnicas como JSON, prompt, fluxo ou sistema.',
    '',
    `Mensagem do usuário: "${ultimaMsg.slice(0, 500)}"`,
  ].join('\n');
}

function promptAnalise(c: Cenario): string {
  return [
    'Você é o Nexo, um consultor de educação financeira amigável, cordial, empático e acolhedor para jovens adultos.',
    'Fale com gentileza, sem broncas ou julgamentos, em português do Brasil.',
    'Escreva a resposta final ao usuário exatamente nos 4 itens numerados abaixo, usando os DADOS fornecidos.',
    '',
    'REGRAS:',
    '- Use SOMENTE os valores dos DADOS, copiados exatamente como estão. Não faça contas e não invente números.',
    `- O item 1 (Veredito) deve começar exatamente com: ${c.veredito}`,
    '- O item 2 (Contas) deve listar obrigatoriamente: Renda, Despesas, Saldo atual, Valor do gasto, Saldo final, % comprometida e o nível de Risco.',
    '- Limite de cartão não é dinheiro disponível.',
    c.cabe
      ? '- No item 4 (Dica prática), sugira de forma realista manter o controle dos gastos ou guardar o valor semanal informado.'
      : '- No item 4 (Dica prática), acolha a vontade de comprar sem julgar e sugira uma ação realista como adiar a compra, cortar gastos ou juntar o valor semanal informado. Não sugira parcelar nem usar o cartão.',
    '- Não mostre raciocínio nem rascunho. Não use termos técnicos.',
    '',
    'DADOS:',
    c.linhasDados,
    '',
    'FORMATO OBRIGATÓRIO (exemplo com números fictícios; não copie os números):',
    '1. **Veredito:** NÃO CABE no orçamento atual.',
    '2. **Contas:** Renda **R$ 2.500,00**, Despesas **R$ 2.100,00**, Saldo atual **R$ 400,00**, Valor do gasto **R$ 650,00** (à vista), Saldo final **-R$ 250,00** e **110,0%** comprometida (Risco: **Crítico**).',
    '3. **Por quê:** Entendo a vontade de fazer essa compra, mas o valor passa do que sobra no mês e deixaria o saldo em **-R$ 250,00**, faltando **R$ 250,00**.',
    '4. **Dica prática:** Que tal adiar por um tempinho e separar **R$ 62,50** por semana até juntar o valor que falta?',
    '',
    'Agora escreva a resposta com os DADOS acima.',
  ].join('\n');
}

function promptConsultoria(base: BaseFinanceira, messages: ChatMessage[]): string {
  const saldoLivre = roundMoney(base.renda - base.totalDespesas);
  const comprometimento = calcularComprometimentoRenda(base.renda, base.totalDespesas);
  const historico = messages
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Nexo' : 'Usuário'}: ${m.content}`)
    .join('\n');

  return [
    'Você é o Nexo, um consultor de educação financeira amigável, cordial, empático e prático para jovens adultos.',
    'Fale em português do Brasil, de forma simples, acolhedora e sem julgamentos.',
    '',
    'DADOS REAIS DO USUÁRIO (USE EXATAMENTE ESTES VALORES):',
    `- Renda mensal líquida: ${formatCurrency(base.renda)}`,
    `- Contas fixas: ${formatCurrency(base.totalFixos)}`,
    `- Gastos variáveis: ${formatCurrency(base.totalVariaveis)}`,
    `- Total de despesas: ${formatCurrency(base.totalDespesas)}`,
    `- Saldo livre atual: ${formatCurrency(saldoLivre)}`,
    `- Comprometimento da renda: ${comprometimento.percentualFormatado} (Risco: ${comprometimento.risco})`,
    '',
    'REGRAS:',
    '- Interprete exatamente o que o usuário perguntou ou comentou na última mensagem e dê uma resposta útil, cordial e personalizada.',
    '- Baseie suas dicas nos dados reais acima e nos gastos que o usuário citou na conversa.',
    '- Nunca faça contas novas de cabeça nem invente números fora dos DADOS REAIS.',
    '- Seja objetivo (máximo 6 frases curtas ou 3 tópicos práticos).',
    '- Não mostre raciocínio interno nem use termos técnicos como JSON, prompt ou sistema.',
    '',
    'CONVERSA RECENTE:',
    historico,
    '',
    'Responda agora à última mensagem do usuário como o Nexo.',
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

function problemasColeta(texto: string): string[] {
  const p: string[] = [];
  if (!texto.includes('?')) p.push('sem pergunta');
  if (texto.length > 650) p.push('resposta longa demais');
  if (/\bjson\b|<think>/i.test(texto)) p.push('termo técnico');
  return p;
}

function problemasAnalise(texto: string, c: Cenario): string[] {
  const p: string[] = [];
  const blocos: Array<[string, RegExp]> = [
    ['Veredito', /veredito/i],
    ['Contas', /contas/i],
    ['Por quê', /por\s*qu[eê]/i],
    ['Dica', /dica/i],
  ];
  for (const [rotulo, re] of blocos) {
    if (!re.test(texto)) p.push(`bloco "${rotulo}" ausente`);
  }
  const linhaVeredito = texto.split('\n').find((l) => /veredito/i.test(l)) ?? '';
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
  if (!c.cabe && !c.parcelado && /parcel/i.test(texto)) p.push('sugeriu parcelar um gasto que não cabe');
  if (/\bjson\b|<think>/i.test(texto)) p.push('termo técnico');
  return p;
}

/* ------------------------------------------------------------------ */
/* CHAMADA AO OLLAMA                                                   */
/* ------------------------------------------------------------------ */

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^(?:thinking process|racioc[ií]nio|fluxo de pensamento):[\s\S]*?(?=\n\n|$)/i, '')
    .trim();
}

async function callOllama(
  prompt: string,
  opts: { temperature?: number; signal?: AbortSignal } = {}
): Promise<{ raw: string; texto: string }> {
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
        num_predict: OLLAMA_THINK ? 2048 : 850,
      },
    }),
    signal: opts.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Erro no Ollama (${response.status}): ${errText || response.statusText}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
    response?: string;
  };
  const raw = data.message?.content ?? data.response ?? '';
  return { raw, texto: stripThinkBlocks(raw) };
}

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

async function responderConversa(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const decisao = decidirFluxo(messages);
  logEvento({
    tipo: 'fluxo',
    fase: decisao.fase,
    ultima_mensagem: decisao.ultimaMsg,
    perfil: decisao.perfil,
    gasto: decisao.gasto,
  });

  switch (decisao.fase) {
    case 'RENDA':
    case 'FIXOS':
    case 'VARIAVEIS': {
      const fase = decisao.fase;
      return gerarComValidacao({
        fase,
        prompt: promptColeta(fase, decisao.ultimaMsg),
        permitidos: permitidosDoUsuario(decisao.ultimaMsg),
        extra: problemasColeta,
        fallback: () => PERGUNTAS_COLETA[fase].fallback,
        signal,
      });
    }

    case 'FECHAMENTO': {
      const base = obterBase(decisao.perfil);
      const texto = textoFechamento(base, decisao.perfil.faixaAtiva);
      logEvento({ tipo: 'resposta_deterministica', fase: 'FECHAMENTO', texto });
      return texto;
    }

    case 'CONSULTORIA': {
      const base = obterBase(decisao.perfil);
      const saldoLivre = roundMoney(base.renda - base.totalDespesas);
      const comprometimento = calcularComprometimentoRenda(base.renda, base.totalDespesas);
      const dadosTexto = [
        formatCurrency(base.renda),
        formatCurrency(base.totalFixos),
        formatCurrency(base.totalVariaveis),
        formatCurrency(base.totalDespesas),
        formatCurrency(saldoLivre),
        comprometimento.percentualFormatado,
      ].join(' ');
      return gerarComValidacao({
        fase: 'CONSULTORIA',
        prompt: promptConsultoria(base, messages),
        permitidos: permitidosDe(dadosTexto, decisao.ultimaMsg),
        extra: (t) => (/\bjson\b|<think>/i.test(t) ? ['termo técnico'] : []),
        fallback: () =>
          `Com base no seu resumo atual (renda de **${formatCurrency(base.renda)}**, despesas de **${formatCurrency(base.totalDespesas)}**, saldo livre de **${formatCurrency(saldoLivre)}** e **${comprometimento.percentualFormatado}** da renda comprometida — risco **${comprometimento.risco}**), o melhor caminho agora é revisar seus gastos variáveis e assinaturas para ganhar mais fôlego no mês. Quer olhar algum gasto específico juntos?`,
        signal,
      });
    }

    case 'ANALISE': {
      const gasto = decisao.gasto as Gasto;
      const base = obterBase(decisao.perfil, gasto);
      const cenario = calcularCenario(base, gasto);
      logEvento({ tipo: 'cenario', valores: cenario.v, cabe: cenario.cabe, nivel: cenario.nivel });
      return gerarComValidacao({
        fase: 'ANALISE',
        prompt: promptAnalise(cenario),
        permitidos: permitidosDe(cenario.linhasDados),
        extra: (t) => problemasAnalise(t, cenario),
        fallback: () => respostaDeterministicaAnalise(cenario),
        signal,
      });
    }
  }
}

async function responderExtrato(
  messages: ChatMessage[],
  financialData: FinancialDataPayload,
  todayISO: string,
  signal?: AbortSignal
): Promise<string> {
  const snapshot = buildDeterministicSnapshot(financialData, todayISO);
  const ultimaMsg = messages.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '';
  logEvento({ tipo: 'fluxo', fase: 'EXTRATO', lancamentos: financialData.transactions?.length ?? 0 });

  // Se o usuário já tem dados no painel e pediu para avaliar uma compra específica com valor
  const { valorGasto, parcelas } = extrairValorGastoEParcelas(ultimaMsg);
  const recMes = Number((snapshot.receitas_mes_atual as Record<string, unknown>).total_geral) || 0;
  const despMes = Number((snapshot.despesas_mes_atual as Record<string, unknown>).total_geral) || 0;

  if (valorGasto !== undefined && REGEX_INTENCAO_COMPRA.test(ultimaMsg) && recMes > 0) {
    const baseExtrato: BaseFinanceira = {
      renda: recMes,
      totalFixos: despMes,
      totalVariaveis: 0,
      totalDespesas: despMes,
    };
    const cenario = calcularCenario(baseExtrato, { valor: valorGasto, parcelas: parcelas ?? 1 });
    logEvento({ tipo: 'cenario_extrato', valores: cenario.v, cabe: cenario.cabe, nivel: cenario.nivel });

    return gerarComValidacao({
      fase: 'ANALISE_EXTRATO',
      prompt: promptAnalise(cenario),
      permitidos: permitidosDe(cenario.linhasDados),
      extra: (t) => problemasAnalise(t, cenario),
      fallback: () => respostaDeterministicaAnalise(cenario),
      signal,
    });
  }

  return gerarComValidacao({
    fase: 'EXTRATO',
    prompt: promptExtrato(todayISO, snapshot, messages),
    permitidos: permitidosDe(JSON.stringify(snapshot), ultimaMsg),
    extra: (t) => (/\bjson\b|<think>/i.test(t) ? ['termo técnico'] : []),
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
    console.log(
      `FinançaExec server listening on http://0.0.0.0:${PORT} (Ollama: ${OLLAMA_URL}, model: ${OLLAMA_MODEL}, think: ${OLLAMA_THINK}, num_ctx: ${OLLAMA_NUM_CTX})`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});