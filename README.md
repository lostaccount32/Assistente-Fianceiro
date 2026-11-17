# Assistente-Fianceiro
Projeto para a disciplina de Engenharia de Prompt

Assistente de finanças pessoais (back-end FastAPI + LangChain/Ollama). Toda a
matemática financeira fica em Python puro, em `backend/financeiro/`, para que a
LLM nunca faça contas.

## Instalação das dependências

Requer Python 3.11+. Na raiz do repositório:

```bash
python3 -m venv .venv            # só na primeira vez
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Para atualizar o arquivo após instalar novas bibliotecas: `pip freeze > requirements.txt`.

## Módulos de cálculo (`backend/financeiro/`)

| Módulo | Função principal | Finalidade |
|---|---|---|
| `utils.py` | `parse_moeda`, `parse_data`, `arredondar` | Arredondamento half-up, parser BRL/US, datas e dias do ciclo |
| `extrator_csv.py` | `extrair_csv_texto`, `extrair_csv_arquivo` | Lê CSV de compras e separa linhas inválidas |
| `normalizador_periodos.py` | `normalizar_periodo` | Converte entre periodicidades e calcula orçamento diário |
| `balanco_orcamentario.py` | `calcular_balanco` | Saldo, comprometimento e dados ausentes |
| `analisador_50_30_20.py` | `analisar_50_30_20` | Regra 50/30/20 e desvios |
| `monitor_metas.py` | `monitorar_meta` | Consumo de meta, severidade e alerta push |
| `simulador_avista.py` | `simular_avista` | Impacto de compra à vista |
| `simulador_parcelamento.py` | `simular_parcelamento` | Parcelas de 2x até N (sem juros ou Tabela Price) |
| `rebalanceador_orcamento.py` | `rebalancear_orcamento` | Cortes nas folgas para cobrir um déficit |

Todas as funções recebem e retornam modelos Pydantic de `schemas.py`; valores
monetários usam `Decimal` com `ROUND_HALF_UP` (nunca `float`).

Uso em código (a partir da raiz do repositório):

```python
from decimal import Decimal
from backend.financeiro import SimulacaoAvistaInput, simular_avista

r = simular_avista(SimulacaoAvistaInput(
    renda_mensal=Decimal("5000"), total_despesas_atuais=Decimal("3000"),
    valor_compra=Decimal("1000")))
print(r.saldo_pos_compra)  # 1000.00
```

## Executando os scripts (testes)

Cada módulo tem testes com `assert` no bloco `if __name__ == "__main__":`.
Execute **a partir da raiz** com `-m` (os imports são relativos), com a `.venv` ativa:

```bash
python -m backend.financeiro.utils
python -m backend.financeiro.extrator_csv
python -m backend.financeiro.normalizador_periodos
python -m backend.financeiro.balanco_orcamentario
python -m backend.financeiro.analisador_50_30_20
python -m backend.financeiro.monitor_metas
python -m backend.financeiro.simulador_avista
python -m backend.financeiro.simulador_parcelamento
python -m backend.financeiro.rebalanceador_orcamento
```

Cada um imprime `<modulo> OK` se todos os asserts passarem; caso contrário
mostra um `AssertionError`. Para rodar todos de uma vez:

```bash
for m in utils extrator_csv normalizador_periodos balanco_orcamentario analisador_50_30_20 monitor_metas simulador_avista simulador_parcelamento rebalanceador_orcamento; do python -W ignore -m backend.financeiro.$m || break; done
```

(O `-W ignore` oculta um `RuntimeWarning` inofensivo do `runpy`.)
