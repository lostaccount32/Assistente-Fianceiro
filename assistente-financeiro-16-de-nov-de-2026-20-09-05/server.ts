import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MODEL_NAME = 'gemini-4-hydrogen';

interface ChatMessage {
  role: 'user' | 'assistant';
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

const brlFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const MONTH_NAMES_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const roundMoney = (val: unknown): number =>
  Math.round((Number(val) + Number.EPSILON) * 100) / 100;

function formatCurrency(val: unknown): string {
  return brlFormatter.format(Number(val) || 0);
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

const AGENT_TOOLS_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'calcular_saldo_total',
    description:
      'Calcula com precisão matemática o saldo acumulado total (receitas totais menos despesas totais) de todo o histórico.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'somar_por_categoria',
    description:
      'Agrupa, soma e calcula porcentagens exatas por categoria em um mês específico (YYYY-MM) ou em todo o histórico ("all").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mes_yyyy_mm: {
          type: Type.STRING,
          description: 'Mês no formato YYYY-MM (ex: "2026-11") ou "all" para todo o histórico.',
        },
        tipo: {
          type: Type.STRING,
          description: 'Filtro: "expense" (despesas), "income" (receitas) ou "all" (ambos).',
        },
      },
      required: ['mes_yyyy_mm', 'tipo'],
    },
  },
  {
    name: 'verificar_metas_financeiras',
    description:
      'Calcula o progresso exato, percentual consumido/atingido e saldo restante/excedido de todas as metas financeiras e tetos mensais.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mes_yyyy_mm: {
          type: Type.STRING,
          description: 'Mês de referência no formato YYYY-MM para os tetos por categoria.',
        },
      },
    },
  },
  {
    name: 'buscar_transacoes',
    description:
      'Filtra lançamentos por palavra-chave (na descrição ou categoria), intervalo de datas (YYYY-MM-DD) e tipo, retornando a soma exata e os itens.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        termo: {
          type: Type.STRING,
          description: 'Termo de busca na descrição ou nome da categoria (opcional).',
        },
        data_inicio: {
          type: Type.STRING,
          description: 'Data inicial YYYY-MM-DD (opcional).',
        },
        data_fim: {
          type: Type.STRING,
          description: 'Data final YYYY-MM-DD (opcional).',
        },
        tipo: {
          type: Type.STRING,
          description: '"expense", "income" ou "all" (opcional).',
        },
      },
    },
  },
  {
    name: 'comparar_ultimos_meses',
    description:
      'Gera o comparativo determinístico mês a mês de receitas, despesas e balanço líquido nos últimos N meses.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        quantidade_meses: {
          type: Type.NUMBER,
          description: 'Quantidade de meses para comparar (padrão: 6).',
        },
      },
    },
  },
];

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
        percentual: totalGeral > 0 ? `${((total / totalGeral) * 100).toFixed(1)}%` : '0.0%',
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
        percentual: `${info.pctRaw.toFixed(1)}%`,
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
      .slice(0, 30)
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

function buildDeterministicSystemPrompt(todayISO: string): string {
  return [
    'Você é o assistente financeiro executivo do FinançaExec, acoplado a um motor determinístico de cálculo.',
    `DATA DE HOJE: ${todayISO} (Mês atual: ${todayISO.slice(0, 7)}).`,
    'REGRAS ESTRITAS:',
    '1. NUNCA faça contas de cabeça ou estime valores. Sempre acione as ferramentas (tools) disponíveis para obter os números exatos.',
    '2. Após receber o resultado JSON das ferramentas, refine a resposta em português do Brasil de forma clara, direta, executiva e amigável.',
    '3. Destaque valores em R$ com **negrito** e use listas com "- " quando houver múltiplos itens.',
    '4. Se não houver lançamentos no período consultado, informe claramente sem inventar números.',
    '5. Você pode dar dicas gerais de organização financeira, mas não recomende investimentos específicos; para decisões importantes, sugira consultar um profissional.',
  ].join('\n');
}

async function runDeterministicGeminiAgent(
  ai: GoogleGenAI,
  initialContents: Content[],
  financialData: FinancialDataPayload,
  abortSignal?: AbortSignal
): Promise<string> {
  const todayISO =
    typeof financialData.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(financialData.today)
      ? financialData.today
      : getServerTodayISO();
  const agentSystemPrompt = buildDeterministicSystemPrompt(todayISO);
  const contents: Content[] = initialContents.slice();

  // Loop ReAct / Tool-Calling (até 5 passos de ferramentas + 1 passo final de síntese se necessário)
  for (let step = 0; step < 6; step++) {
    const isFinalSynthesis = step === 5;
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents,
      config: {
        systemInstruction: agentSystemPrompt,
        tools: [{ functionDeclarations: AGENT_TOOLS_DECLARATIONS }],
        toolConfig: {
          functionCallingConfig: {
            mode: isFinalSynthesis
              ? FunctionCallingConfigMode.NONE
              : FunctionCallingConfigMode.AUTO,
          },
        },
        abortSignal,
      },
    });

    const modelContent = response.candidates?.[0]?.content;
    const functionCalls = response.functionCalls;

    if (!isFinalSynthesis && functionCalls && functionCalls.length > 0 && modelContent) {
      contents.push(modelContent);

      const functionResponseParts = functionCalls.map((fc) => {
        const fnName = fc.name || '';
        const result = executeDeterministicTool(
          fnName,
          (fc.args || {}) as Record<string, unknown>,
          financialData
        );
        return {
          functionResponse: {
            ...(fc.id ? { id: fc.id } : {}),
            name: fnName,
            response: { result },
          },
        };
      });

      contents.push({
        role: 'user',
        parts: functionResponseParts,
      });
      continue;
    }

    return (response.text || '').trim();
  }

  return '';
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/api/chat', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(500).json({
        error: 'Chave GEMINI_API_KEY não configurada no servidor. Configure em Settings > Secrets.',
      });
      return;
    }

    const { system, messages, stream, financial_data } = (req.body || {}) as {
      system?: string;
      messages?: ChatMessage[];
      stream?: boolean;
      financial_data?: FinancialDataPayload;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Envie ao menos uma mensagem para o assistente.' });
      return;
    }

    const contents: Content[] = messages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content.slice(0, 4000) }],
      }));

    if (contents.length === 0) {
      res.status(400).json({ error: 'Conteúdo da mensagem inválido.' });
      return;
    }

    const useDeterministicAgent = Boolean(
      financial_data && typeof financial_data === 'object'
    );

    if (useDeterministicAgent && financial_data) {
      const abortController = new AbortController();
      req.on('close', () => {
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
          const replyText = await runDeterministicGeminiAgent(
            ai,
            contents,
            financial_data,
            abortController.signal
          );
          if (replyText && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ text: replyText })}\n\n`);
          }
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Erro ao consultar o modelo.';
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
            res.end();
          }
        }
        return;
      }

      try {
        const replyText = await runDeterministicGeminiAgent(
          ai,
          contents,
          financial_data,
          abortController.signal
        );
        res.json({ reply: replyText });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erro ao consultar o modelo.';
        res.status(500).json({ error: message });
      }
      return;
    }

    const config =
      system && typeof system === 'string'
        ? { systemInstruction: system.slice(0, 20000) }
        : undefined;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const abortController = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      try {
        const responseStream = await ai.models.generateContentStream({
          model: MODEL_NAME,
          contents,
          config: {
            ...config,
            abortSignal: abortController.signal,
          },
        });

        for await (const chunk of responseStream) {
          const text = chunk.text || '';
          if (text && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        }
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erro ao consultar o modelo.';
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
          res.end();
        }
      }
      return;
    }

    try {
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents,
        config,
      });
      res.json({ reply: response.text || '' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao consultar o modelo.';
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
    console.log(`FinançaExec server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
