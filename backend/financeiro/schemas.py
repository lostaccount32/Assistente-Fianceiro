from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum
from typing import Annotated
from pydantic import BaseModel, Field, AfterValidator


def _quantizar_moeda(valor: Decimal) -> Decimal:
    return valor.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


Moeda = Annotated[Decimal, AfterValidator(_quantizar_moeda)]


# =====================================================================
# ENUMS COMPARTILHADOS
# =====================================================================

class Periodicidade(str, Enum):
    DIARIA = "diaria"
    SEMANAL = "semanal"
    QUINZENAL = "quinzenal"
    MENSAL = "mensal"
    ANUAL = "anual"


class Pilar503020(str, Enum):
    NECESSIDADES = "necessidades"   # 50%
    DESEJOS = "desejos"             # 30%
    POUPANCA_DIVIDAS = "poupanca"   # 20%


class NivelSeveridade(str, Enum):
    NORMAL = "NORMAL"     # < 80% da meta
    ALERTA = "ALERTA"     # 80% a 100% da meta
    CRITICO = "CRITICO"   # > 100% da meta


class EstrategiaRebalanceamento(str, Enum):
    PRIORIZAR_DESEJOS = "priorizar_desejos"
    PROPORCIONAL_GERAL = "proporcional_geral"


# =====================================================================
# [1] EXTRATOR CSV (extrator_csv.py)
# =====================================================================

class TransacaoValidada(BaseModel):
    data: date
    estabelecimento: str
    valor: Moeda
    categoria: str = "Outros"
    pilar: Pilar503020 = Pilar503020.DESEJOS


class ErroLinhaCsv(BaseModel):
    linha: int
    conteudo_bruto: str
    motivo: str


class ExtracaoCsvOutput(BaseModel):
    transacoes: list[TransacaoValidada]
    erros: list[ErroLinhaCsv]
    total_validado: Moeda
    quantidade_validas: int
    quantidade_ignoradas: int


# =====================================================================
# [2] NORMALIZADOR DE PERÍODOS (normalizador_periodos.py)
# =====================================================================

class NormalizacaoPeriodoInput(BaseModel):
    valor: Moeda = Field(gt=0, description="Valor monetário original")
    periodo_origem: Periodicidade
    periodo_destino: Periodicidade
    data_referencia: date = Field(default_factory=date.today)


class NormalizacaoPeriodoOutput(BaseModel):
    valor_original: Moeda
    valor_convertido: Moeda
    orcamento_diario_medio: Moeda
    dias_restantes_ciclo: int
    dias_totais_ciclo: int


# =====================================================================
# [3] BALANÇO ORÇAMENTÁRIO (balanco_orcamentario.py)
# =====================================================================

class DespesaItem(BaseModel):
    descricao: str
    valor: Moeda = Field(ge=0)
    categoria: str = "Geral"
    pilar: Pilar503020 = Pilar503020.NECESSIDADES
    valor_pendente_informacao: bool = Field(
        default=False,
        description="True quando o usuário citou a despesa sem informar o valor (ex: 'umas assinaturas')"
    )


class BalancoOrcamentarioInput(BaseModel):
    renda_mensal: Moeda | None = Field(default=None, ge=0)
    despesas: list[DespesaItem] = Field(default_factory=list)
    gasto_pretendido: Moeda | None = Field(default=None, ge=0)
    saldo_informado_usuario: Moeda | None = Field(default=None)


class BalancoOrcamentarioOutput(BaseModel):
    dados_completos: bool
    campos_faltantes: list[str]
    despesas_sem_valor_citadas: list[str]
    renda_mensal: Moeda
    total_despesas: Moeda
    saldo_disponivel: Moeda
    percentual_comprometido: Decimal
    divergencia_saldo_informado: Moeda | None = None


# =====================================================================
# [4] ANALISADOR 50/30/20 (analisador_50_30_20.py)
# =====================================================================

class Analise503020Input(BaseModel):
    renda_mensal: Moeda = Field(gt=0)
    despesas: list[DespesaItem]


class DetalhePilar(BaseModel):
    pilar: Pilar503020
    percentual_ideal: Decimal
    valor_ideal: Moeda
    valor_atual: Moeda
    percentual_atual: Decimal
    desvio_valor: Moeda          # Positivo = estourou o teto; Negativo = abaixo do teto
    desvio_percentual: Decimal


class Analise503020Output(BaseModel):
    renda_base: Moeda
    pilares: list[DetalhePilar]
    pilar_mais_critico: Pilar503020 | None
    dentro_do_equilibrio: bool


# =====================================================================
# [5] MONITOR DE METAS (monitor_metas.py)
# =====================================================================

class MonitorMetaInput(BaseModel):
    categoria: str
    limite_meta: Moeda = Field(gt=0)
    gasto_acumulado_anterior: Moeda = Field(ge=0)
    nova_transacao: Moeda = Field(default=Decimal("0.00"), ge=0)


class MonitorMetaOutput(BaseModel):
    categoria: str
    limite_meta: Moeda
    gasto_acumulado_atual: Moeda
    saldo_restante: Moeda
    valor_estouro: Moeda
    percentual_consumido: Decimal
    severidade: NivelSeveridade
    disparar_alerta_push: bool


# =====================================================================
# [6] SIMULADOR À VISTA (simulador_avista.py)
# =====================================================================

class SimulacaoAvistaInput(BaseModel):
    renda_mensal: Moeda = Field(gt=0)
    total_despesas_atuais: Moeda = Field(ge=0)
    valor_compra: Moeda = Field(gt=0)


class SimulacaoAvistaOutput(BaseModel):
    saldo_antes_compra: Moeda
    saldo_pos_compra: Moeda
    deficit_gerado: Moeda
    percentual_comprometimento_atual: Decimal
    percentual_comprometimento_pos_compra: Decimal
    cabe_no_orcamento: bool


# =====================================================================
# [7] SIMULADOR DE PARCELAMENTO (simulador_parcelamento.py)
# =====================================================================

class SimulacaoParcelamentoInput(BaseModel):
    renda_mensal: Moeda = Field(gt=0)
    total_despesas_atuais: Moeda = Field(ge=0)
    valor_compra: Moeda = Field(gt=0)
    taxa_juros_mensal_percentual: Decimal = Field(default=Decimal("0.00"), ge=0)
    max_parcelas: int = Field(default=12, ge=2, le=48)


class OpcaoParcela(BaseModel):
    numero_parcelas: int
    valor_parcela: Moeda
    valor_total_pago: Moeda
    custo_juros: Moeda
    saldo_mensal_restante: Moeda
    novo_percentual_comprometimento: Decimal
    viavel_no_orcamento: bool


class SimulacaoParcelamentoOutput(BaseModel):
    folga_mensal_atual: Moeda
    opcoes: list[OpcaoParcela]
    menor_parcelamento_viavel: OpcaoParcela | None
    existe_opcao_viavel: bool


# =====================================================================
# [8] REBALANCEADOR DE ORÇAMENTO (rebalanceador_orcamento.py)
# =====================================================================

class CategoriaFolga(BaseModel):
    categoria: str
    pilar: Pilar503020
    limite_meta: Moeda
    gasto_atual: Moeda
    saldo_disponivel: Moeda


class RebalanceamentoInput(BaseModel):
    valor_deficit_compensar: Moeda = Field(gt=0)
    dias_restantes_periodo: int = Field(ge=1)
    categorias_disponiveis: list[CategoriaFolga]
    estrategia: EstrategiaRebalanceamento = EstrategiaRebalanceamento.PRIORIZAR_DESEJOS


class PlanoCorteCategoria(BaseModel):
    categoria: str
    pilar: Pilar503020
    folga_anterior: Moeda
    valor_cortar: Moeda
    novo_limite_disponivel: Moeda
    novo_teto_diario: Moeda


class RebalanceamentoOutput(BaseModel):
    deficit_total: Moeda
    total_folga_encontrada: Moeda
    deficit_coberto_integralmente: bool
    saldo_descoberto_restante: Moeda
    economia_diaria_necessaria: Moeda
    cortes_sugeridos: list[PlanoCorteCategoria]
