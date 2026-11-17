"""Cálculo financeiro determinístico: toda a matemática fica aqui, nunca na LLM."""

from .schemas import (
    Analise503020Input, Analise503020Output, BalancoOrcamentarioInput,
    BalancoOrcamentarioOutput, CategoriaFolga, DespesaItem, DetalhePilar,
    ErroLinhaCsv, EstrategiaRebalanceamento, ExtracaoCsvOutput, MonitorMetaInput,
    MonitorMetaOutput, Moeda, NivelSeveridade, NormalizacaoPeriodoInput,
    NormalizacaoPeriodoOutput, OpcaoParcela, Periodicidade, Pilar503020,
    PlanoCorteCategoria, RebalanceamentoInput, RebalanceamentoOutput,
    SimulacaoAvistaInput, SimulacaoAvistaOutput, SimulacaoParcelamentoInput,
    SimulacaoParcelamentoOutput, TransacaoValidada,
)
from .analisador_50_30_20 import analisar_50_30_20
from .balanco_orcamentario import calcular_balanco
from .extrator_csv import extrair_csv_arquivo, extrair_csv_texto
from .monitor_metas import classificar_severidade, monitorar_meta
from .normalizador_periodos import normalizar_periodo
from .rebalanceador_orcamento import rebalancear_orcamento
from .simulador_avista import simular_avista
from .simulador_parcelamento import parcelas_detalhadas, simular_parcelamento
from .utils import (
    arredondar, arredondar_moeda, arredondar_percentual, dias_restantes_ciclo,
    dias_totais_ciclo, parse_data, parse_moeda, percentual,
)

__all__ = [
    # funções
    "analisar_50_30_20", "calcular_balanco", "extrair_csv_arquivo", "extrair_csv_texto",
    "classificar_severidade", "monitorar_meta", "normalizar_periodo",
    "rebalancear_orcamento", "simular_avista", "simular_parcelamento", "parcelas_detalhadas",
    "arredondar", "arredondar_moeda", "arredondar_percentual", "percentual",
    "dias_restantes_ciclo", "dias_totais_ciclo", "parse_data", "parse_moeda",
    # schemas
    "Moeda", "Periodicidade", "Pilar503020", "NivelSeveridade", "EstrategiaRebalanceamento",
    "TransacaoValidada", "ErroLinhaCsv", "ExtracaoCsvOutput",
    "NormalizacaoPeriodoInput", "NormalizacaoPeriodoOutput",
    "DespesaItem", "BalancoOrcamentarioInput", "BalancoOrcamentarioOutput",
    "Analise503020Input", "DetalhePilar", "Analise503020Output",
    "MonitorMetaInput", "MonitorMetaOutput",
    "SimulacaoAvistaInput", "SimulacaoAvistaOutput",
    "SimulacaoParcelamentoInput", "OpcaoParcela", "SimulacaoParcelamentoOutput",
    "CategoriaFolga", "RebalanceamentoInput", "PlanoCorteCategoria", "RebalanceamentoOutput",
]
